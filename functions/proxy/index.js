'use strict';
/**
 * EP03「Key 泄露体验页」代理云函数
 * --------------------------------------------------------------
 * 部署位置：腾讯云开发 CloudBase 云函数（HTTP 访问服务，路径 /api/proxy）
 * 运行时：Nodejs 16+（仅使用内置模块，无需安装任何依赖）
 *
 * 判断顺序（与方案一致）：
 *   1. OPTIONS → 直接放行（跨域预检）
 *   2. 按 IP 滑动窗口限流（默认 30 次/小时）
 *   3. 有 X-User-Key → user 路径（用用户的 Key 调上游）
 *   4. 否则校验 X-Demo-Token + X-Demo-Session → demo 路径
 *   5. 演示池额度 ≤ 0 → DEMO_QUOTA_EXHAUSTED；否则扣减一次再调上游
 *
 * 会话机制：
 *   X-Demo-Session 为 HMAC 自签名令牌（含 24 小时过期时间），
 *   任意函数实例都能校验，无需数据库，页面与视频 curl 天然一致。
 *
 * 环境变量：
 *   UPSTREAM_API_KEY    必填，阿里云百炼官方真 Key（只存在于此，前端永远拿不到）
 *   DEMO_TOKEN          必填，演示令牌，必须与前端 CONFIG.demoToken 一致
 *   SESSION_SECRET      建议填写，会话签名密钥（不填则用开发默认值）
 *   UPSTREAM_MODEL      可选，默认 qwen-plus
 *   DEMO_SESSION_FREE   可选，每会话免费额度（前端显示），默认 2
 *   DEMO_SESSION_LIMIT  可选，每会话总额度（免费 + 解锁示例 Key 后可用），默认 5
 *   DEMO_DAILY_LIMIT    可选，每日总预算兜底，默认 300（所有观众合计，保护账号）
 *   IP_DAILY_LIMIT      可选，每 IP 每日演示调用上限，默认 15（防刷）
 *   RATE_LIMIT_PER_HOUR 可选，每 IP 每小时调用上限，默认 30
 *   UPSTREAM_BASE_URL   可选，上游地址（仅本地测试用）
 */
const crypto = require('crypto');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Demo-Token, X-Demo-Session, X-User-Key',
  'Access-Control-Max-Age': '86400',
};

const SYSTEM_PROMPT =
  "你是「大肥鱼」，一条有点傲娇但真诚的 AI 夸夸鱼。根据用户给的内容，" +
  '用一两句话真诚又有趣地夸奖 TA，50 字以内，活泼自然，不要太正式，不要编造事实。';

// ---- 内存状态（每实例一份；实例回收即重置，属方案约定的轻量行为） ----
const sessionQuota = new Map(); // sessId -> { used, unlocked, exp }
let globalQuota = { date: '', remaining: 0 }; // 每日总预算兜底（保护账号）
const ipHits = new Map(); // ip -> { windowStart, count }（每小时）
const ipDaily = new Map(); // ip -> { date, count }（每日演示调用）

function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

/** 北京时间（UTC+8）的 YYYY-MM-DD，用于每日重置 */
function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 日期变更时自动重置全局每日预算兜底 */
function ensureGlobalQuota() {
  const today = todayCN();
  if (globalQuota.date !== today) {
    globalQuota = { date: today, remaining: envInt('DEMO_DAILY_LIMIT', 100) };
  }
  return globalQuota;
}

/** 按会话独立分配演示额度；过期或实例回收后重新发放 */
function sessionRandom(s) {
  if (typeof s !== 'string' || !s.startsWith('sess_')) return null;
  const body = s.slice(5);
  const i = body.lastIndexOf('_');
  if (i <= 0) return null;
  const payload = body.slice(0, i);
  try { return JSON.parse(Buffer.from(payload, 'hex').toString('utf8')).r; } catch (_) { return null; }
}

function getSessionQuota(sess) {
  const id = sessionRandom(sess);
  if (!id) return null;
  const now = Date.now();
  if (sessionQuota.size > 2000) {
    for (const [k, v] of sessionQuota) if (v.exp < now) sessionQuota.delete(k);
  }
  let q = sessionQuota.get(id);
  if (!q || q.exp < now) {
    q = { used: 0, unlocked: false, exp: now + 24 * 3600 * 1000 };
    sessionQuota.set(id, q);
  }
  return q;
}

/** 每 IP 每日演示调用上限（防反复刷新会话刷取免费额度） */
function ipDailyLimited(ip) {
  const limit = envInt('IP_DAILY_LIMIT', 15);
  const today = todayCN();
  let rec = ipDaily.get(ip);
  if (!rec || rec.date !== today) {
    rec = { date: today, count: 0 };
    ipDaily.set(ip, rec);
  }
  rec.count += 1;
  return rec.count > limit;
}

/** 按 IP 的固定窗口限流（每小时），超限返回 true */
function rateLimited(ip) {
  const limit = envInt('RATE_LIMIT_PER_HOUR', 30);
  const now = Date.now();
  let rec = ipHits.get(ip);
  if (!rec || now - rec.windowStart >= 3600 * 1000) {
    rec = { windowStart: now, count: 0 };
    ipHits.set(ip, rec);
  }
  rec.count += 1;
  return rec.count > limit;
}

// ---- 会话：HMAC 自签名（hex 编码，不含下划线，安全拆分） ----
function sessionSecret() {
  return process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
}

function issueSession() {
  const payload = Buffer.from(
    JSON.stringify({ r: crypto.randomBytes(6).toString('hex'), e: Date.now() + 24 * 3600 * 1000 })
  ).toString('hex');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex').slice(0, 16);
  return `sess_${payload}_${sig}`;
}

function validSession(s) {
  if (typeof s !== 'string' || !s.startsWith('sess_')) return false;
  const body = s.slice(5);
  const i = body.lastIndexOf('_');
  if (i <= 0) return false;
  const payload = body.slice(0, i);
  const sig = body.slice(i + 1);
  const expect = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex').slice(0, 16);
  try {
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expect, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const data = JSON.parse(Buffer.from(payload, 'hex').toString('utf8'));
    return typeof data.e === 'number' && data.e > Date.now();
  } catch (_) {
    return false;
  }
}

// ---- 上游调用（OpenAI 兼容接口，内置 https/http，无第三方依赖） ----
function callUpstream(apiKey, model, prompt) {
  return new Promise((resolve, reject) => {
    const base = process.env.UPSTREAM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const url = new URL(base + '/chat/completions');
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 150,
      temperature: 0.9,
    });
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 8000, // 函数超时 10 秒，上游预留 2 秒余量
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function safeExtractReply(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    return typeof content === 'string' && content.trim() ? content.trim() : null;
  } catch (_) {
    return null;
  }
}

function getClientIp(ev, headers) {
  if (ev.requestContext && ev.requestContext.sourceIp) return ev.requestContext.sourceIp;
  const xff = headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return headers['x-real-ip'] || 'unknown';
}

exports.main = async (event) => {
  let ev = event;
  if (typeof ev === 'string') {
    try { ev = JSON.parse(ev); } catch (_) { ev = {}; }
  }
  ev = ev || {};

  const method = String(ev.httpMethod || 'POST').toUpperCase();
  const headers = {};
  Object.keys(ev.headers || {}).forEach((k) => {
    headers[String(k).toLowerCase()] = String(ev.headers[k]);
  });

  const respond = (statusCode, obj) => ({
    isBase64Encoded: false,
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS),
    body: JSON.stringify(obj),
  });

  // 0. 跨域预检
  if (method === 'OPTIONS') {
    return { isBase64Encoded: false, statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (method === 'GET') {
    return respond(200, {
      ok: false,
      error: 'USE_POST',
      hint: 'POST JSON：{"action":"session"} 领取会话；{"action":"chat","prompt":"..."} 调用夸夸',
    });
  }

  // 1. 按 IP 限流
  const ip = getClientIp(ev, headers);
  if (rateLimited(ip)) {
    return respond(429, { ok: false, error: 'RATE_LIMITED' });
  }

  // 2. 解析请求体
  let raw = ev.body || '';
  if (ev.isBase64Encoded && raw) raw = Buffer.from(raw, 'base64').toString('utf8');
  let bodyObj = {};
  if (raw) {
    try { bodyObj = JSON.parse(raw); } catch (_) { return respond(400, { ok: false, error: 'BAD_JSON' }); }
  }

  // 3. 领取会话（页面加载时调用，无需凭证，仅限流保护）
  if (bodyObj.action === 'session') {
    const s = issueSession();
    const q = getSessionQuota(s);
    const free = envInt('DEMO_SESSION_FREE', 2);
    return respond(200, {
      ok: true,
      session: s,
      demoRemaining: Math.max(0, free - q.used),
      demoLimit: free,
      total: envInt('DEMO_SESSION_LIMIT', 5),
    });
  }

  // 3b. 查询本会话剩余额度（窃取面板标注用，需有效会话）
  if (bodyObj.action === 'quota') {
    const sess = headers['x-demo-session'];
    if (!validSession(sess)) return respond(401, { ok: false, error: 'UNAUTHORIZED' });
    const sq = getSessionQuota(sess);
    const total = envInt('DEMO_SESSION_LIMIT', 5);
    return respond(200, {
      ok: true,
      used: sq.used,
      remaining: Math.max(0, total - sq.used),
      total,
      free: envInt('DEMO_SESSION_FREE', 2),
      unlocked: sq.unlocked,
    });
  }

  // 3c. 解锁：粘贴示例 Key（演示令牌）验证通过 → 放行剩余次数
  if (bodyObj.action === 'unlock') {
    const sess = headers['x-demo-session'];
    if (!validSession(sess)) return respond(401, { ok: false, error: 'UNAUTHORIZED' });
    const tk = (bodyObj.token && String(bodyObj.token)) || headers['x-demo-token'] || '';
    if (!tk || tk !== process.env.DEMO_TOKEN) {
      return respond(200, { ok: false, error: 'BAD_KEY' });
    }
    const sq = getSessionQuota(sess);
    sq.unlocked = true;
    const total = envInt('DEMO_SESSION_LIMIT', 5);
    return respond(200, { ok: true, remaining: Math.max(0, total - sq.used), total });
  }

  // 4. 夸夸调用
  const prompt = typeof bodyObj.prompt === 'string' ? bodyObj.prompt.trim() : '';
  if (!prompt) return respond(400, { ok: false, error: 'EMPTY_PROMPT' });
  const model = process.env.UPSTREAM_MODEL || 'qwen-turbo';

  // 4a. user 路径：请求头带 X-User-Key 优先
  const userKey = headers['x-user-key'];
  if (userKey) {
    try {
      const up = await callUpstream(userKey, model, prompt);
      if (up.status === 200) {
        const reply = safeExtractReply(up.body);
        if (reply) return respond(200, { ok: true, quota_source: 'user', reply });
        return respond(200, { ok: false, quota_source: 'user', error: 'UPSTREAM_BAD_RESPONSE' });
      }
      if (up.status === 401 || up.status === 403) {
        return respond(200, { ok: false, quota_source: 'user', error: 'USER_KEY_INVALID' });
      }
      if (up.status === 429) {
        return respond(200, { ok: false, quota_source: 'user', error: 'USER_QUOTA_EXHAUSTED' });
      }
      return respond(200, { ok: false, quota_source: 'user', error: 'UPSTREAM_ERROR', upstream_status: up.status });
    } catch (_) {
      return respond(200, { ok: false, quota_source: 'user', error: 'UPSTREAM_TIMEOUT' });
    }
  }

  // 4b. demo 路径：校验演示令牌 + 会话（第一道防线）
  const token = headers['x-demo-token'];
  const sess = headers['x-demo-session'];
  if (!token || token !== process.env.DEMO_TOKEN || !validSession(sess)) {
    return respond(401, { ok: false, error: 'UNAUTHORIZED' });
  }

  // 5. 两段式会话额度：免费次数用完后需粘贴示例 Key 解锁剩余次数
  const total = envInt('DEMO_SESSION_LIMIT', 5);
  const free = envInt('DEMO_SESSION_FREE', 2);
  const sq = getSessionQuota(sess);
  if (!sq) return respond(401, { ok: false, error: 'UNAUTHORIZED' });
  if (sq.used >= total) {
    return respond(200, { ok: false, quota_source: 'demo', error: 'DEMO_QUOTA_EXHAUSTED', remaining: 0 });
  }
  if (sq.used >= free && !sq.unlocked) {
    return respond(200, { ok: false, quota_source: 'demo', error: 'SESSION_KEY_REQUIRED', remaining: total - sq.used });
  }
  // 全局每日预算兜底 + 每 IP 每日演示上限
  const gq = ensureGlobalQuota();
  if (gq.remaining <= 0) {
    return respond(200, { ok: false, quota_source: 'demo', error: 'DEMO_QUOTA_EXHAUSTED', remaining: 0 });
  }
  if (ipDailyLimited(ip)) {
    return respond(429, { ok: false, error: 'IP_DAILY_LIMITED' });
  }
  sq.used += 1;
  gq.remaining -= 1;

  try {
    const up = await callUpstream(process.env.UPSTREAM_API_KEY || '', model, prompt);
    if (up.status === 200) {
      const reply = safeExtractReply(up.body);
      if (reply) return respond(200, { ok: true, quota_source: 'demo', reply, remaining: total - sq.used, unlocked: sq.unlocked });
    }
    sq.used -= 1; gq.remaining += 1;
    return respond(200, { ok: false, quota_source: 'demo', error: 'UPSTREAM_ERROR', remaining: total - sq.used });
  } catch (_) {
    sq.used -= 1; gq.remaining += 1;
    return respond(200, { ok: false, quota_source: 'demo', error: 'UPSTREAM_TIMEOUT', remaining: total - sq.used });
  }
};

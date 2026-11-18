'use strict';
/**
 * 本地验证脚本：node test-local.js
 * 用本地 mock 上游（OpenAI 兼容格式）验证云函数全部判断逻辑，不消耗真实额度。
 */
const http = require('http');
const crypto = require('crypto');

process.env.UPSTREAM_API_KEY = 'sk-test-official';
process.env.DEMO_TOKEN = 'demo_test_token';
process.env.SESSION_SECRET = 'test-secret';
process.env.DEMO_SESSION_FREE = '2';
process.env.DEMO_SESSION_LIMIT = '5';
process.env.DEMO_DAILY_LIMIT = '100'; // 全局预算兜底，测试不触发
process.env.IP_DAILY_LIMIT = '1000'; // 测试单独用例里再压低
process.env.RATE_LIMIT_PER_HOUR = '1000';

// ---------- mock 上游 ----------
let lastAuth = '';
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastAuth = req.headers.authorization || '';
    if (lastAuth === 'Bearer user-429') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'quota exhausted' } }));
    }
    if (lastAuth === 'Bearer user-bad') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'mock 夸奖：你真棒！' } }] }));
  });
});

// ---------- 测试框架 ----------
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`); }
}

function makeEvent(bodyObj, extraHeaders, method, ip) {
  return {
    httpMethod: method || 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: bodyObj == null ? '' : JSON.stringify(bodyObj),
    isBase64Encoded: false,
    requestContext: { sourceIp: ip || '127.0.0.1' },
  };
}

async function main() {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${port}/v1`;

  const { main: handler } = require('./index.js');
  let posts = 0; // 与云函数限流计数一致：只有 POST 计入
  async function call(bodyObj, extraHeaders, method, ip) {
    const m = method || 'POST';
    if (m !== 'GET' && m !== 'OPTIONS' && (!ip || ip === '127.0.0.1')) posts += 1; // 只计默认 IP，供限流用例断言
    const r = await handler(makeEvent(bodyObj, extraHeaders, method, ip), {});
    let json = null;
    try { json = r.body ? JSON.parse(r.body) : null; } catch (_) { /* noop */ }
    return { status: r.statusCode, json };
  }

  console.log('== 基础路由 ==');
  let r = await call(null, {}, 'OPTIONS');
  check('OPTIONS 预检返回 204', r.status === 204);
  r = await call(null, {}, 'GET');
  check('GET 返回 USE_POST 提示', r.status === 200 && r.json.error === 'USE_POST');

  console.log('== 会话签发 ==');
  r = await call({ action: 'session' });
  check('session 签发成功', r.status === 200 && r.json.ok === true);
  check('session 以 sess_ 开头', typeof r.json.session === 'string' && r.json.session.startsWith('sess_'));
  check('初始免费额度 = 2/2（总 5）', r.json.demoRemaining === 2 && r.json.demoLimit === 2 && r.json.total === 5);
  const sess = r.json.session;

  console.log('== demo 路径鉴权 ==');
  r = await call({ action: 'chat', prompt: 'hi' });
  check('无凭证 → 401', r.status === 401 && r.json.error === 'UNAUTHORIZED');
  r = await call({ action: 'chat', prompt: 'hi' }, { 'X-Demo-Token': 'wrong', 'X-Demo-Session': sess });
  check('错误令牌 → 401', r.status === 401);
  const tampered = sess.slice(0, -1) + (sess.endsWith('0') ? '1' : '0');
  r = await call({ action: 'chat', prompt: 'hi' }, { 'X-Demo-Token': process.env.DEMO_TOKEN, 'X-Demo-Session': tampered });
  check('篡改会话 → 401', r.status === 401);
  const expiredPayload = Buffer.from(JSON.stringify({ r: 'aaaa', e: Date.now() - 1000 })).toString('hex');
  const expiredSig = crypto.createHmac('sha256', 'test-secret').update(expiredPayload).digest('hex').slice(0, 16);
  r = await call({ action: 'chat', prompt: 'hi' }, { 'X-Demo-Token': process.env.DEMO_TOKEN, 'X-Demo-Session': `sess_${expiredPayload}_${expiredSig}` });
  check('过期会话 → 401', r.status === 401);
  r = await call({ action: 'chat', prompt: '   ' }, { 'X-Demo-Token': process.env.DEMO_TOKEN, 'X-Demo-Session': sess });
  check('空 prompt → 400', r.status === 400 && r.json.error === 'EMPTY_PROMPT');

  console.log('== 演示路径（免费段 2 次）==');
  const demoH = { 'X-Demo-Token': process.env.DEMO_TOKEN, 'X-Demo-Session': sess };
  r = await call({ action: 'chat', prompt: '今天写了一集教程' }, demoH);
  check('第 1 次成功，剩 4/5', r.json.ok === true && r.json.quota_source === 'demo' && r.json.remaining === 4 && r.json.unlocked === false);
  check('demo 调用用的是官方 Key', lastAuth === 'Bearer sk-test-official');

  console.log('== 上游失败退还额度 ==');
  const realBase = process.env.UPSTREAM_BASE_URL;
  process.env.UPSTREAM_BASE_URL = 'http://127.0.0.1:1/v1'; // 不可达端口
  r = await call({ action: 'chat', prompt: 'hi' }, demoH);
  check('上游失败返回错误', r.json.ok === false && r.json.quota_source === 'demo');
  process.env.UPSTREAM_BASE_URL = realBase;
  r = await call({ action: 'chat', prompt: 'hi' }, demoH);
  // 失败已退还：此刻 used=1，本次成功扣减后剩 3（若未退还，这里会剩 2）
  check('失败未消耗额度（本次成功后剩 3）', r.json.ok === true && r.json.remaining === 3);

  console.log('== 免费段用完 → 需解锁 ==');
  r = await call({ action: 'chat', prompt: 'hi' }, demoH);
  check('第 3 次 → SESSION_KEY_REQUIRED（剩 3 待解锁）', r.json.ok === false && r.json.error === 'SESSION_KEY_REQUIRED' && r.json.remaining === 3);

  console.log('== 解锁与面板查询 ==');
  r = await call({ action: 'unlock', token: 'wrong_key' }, { 'X-Demo-Session': sess });
  check('错误 Key 解锁失败 → BAD_KEY', r.json.ok === false && r.json.error === 'BAD_KEY');
  r = await call({ action: 'unlock', token: process.env.DEMO_TOKEN }, { 'X-Demo-Session': sess });
  check('示例 Key 解锁成功，剩 3', r.json.ok === true && r.json.remaining === 3);
  r = await call({ action: 'chat', prompt: 'hi' }, demoH);
  check('解锁后继续调用成功，剩 2', r.json.ok === true && r.json.remaining === 2 && r.json.unlocked === true);
  r = await call({ action: 'quota' }, { 'X-Demo-Session': sess });
  check('quota 查询：已解锁剩 2/5', r.json.ok === true && r.json.remaining === 2 && r.json.unlocked === true && r.json.total === 5);
  r = await call({ action: 'quota' }, { 'X-Demo-Session': 'sess_deadbeef_0000' });
  check('quota 无效会话 → 401', r.status === 401);
  r = await call({ action: 'chat', prompt: 'hi' }, demoH);
  check('第 4 次成功，剩 1', r.json.ok === true && r.json.remaining === 1);
  r = await call({ action: 'chat', prompt: 'hi' }, demoH);
  check('第 5 次后剩 0', r.json.ok === true && r.json.remaining === 0);
  r = await call({ action: 'chat', prompt: 'hi' }, demoH);
  check('全部耗尽 → DEMO_QUOTA_EXHAUSTED', r.json.ok === false && r.json.error === 'DEMO_QUOTA_EXHAUSTED' && r.json.remaining === 0);

  console.log('== 会话隔离 ==');
  r = await call({ action: 'session' });
  const sess2 = r.json.session;
  check('新会话重新领到免费 2 次（不受旧会话影响）', r.json.demoRemaining === 2 && r.json.demoLimit === 2);
  r = await call({ action: 'chat', prompt: 'hi' }, { 'X-Demo-Token': process.env.DEMO_TOKEN, 'X-Demo-Session': sess2 });
  check('新会话独立扣减，剩 4', r.json.ok === true && r.json.remaining === 4);
  r = await call({ action: 'chat', prompt: 'hi' }, demoH);
  check('旧会话保持耗尽（互不影响）', r.json.ok === false && r.json.error === 'DEMO_QUOTA_EXHAUSTED');

  console.log('== user 路径（优先级高于 demo 凭证） ==');
  r = await call({ action: 'chat', prompt: 'hi' }, Object.assign({ 'X-User-Key': 'user-good' }, demoH));
  check('用户 Key 正常 → quota_source=user', r.json.ok === true && r.json.quota_source === 'user');
  check('user 调用透传用户 Key', lastAuth === 'Bearer user-good');
  r = await call({ action: 'chat', prompt: 'hi' }, { 'X-User-Key': 'user-429' });
  check('用户 Key 429 → USER_QUOTA_EXHAUSTED', r.json.ok === false && r.json.error === 'USER_QUOTA_EXHAUSTED');
  r = await call({ action: 'chat', prompt: 'hi' }, { 'X-User-Key': 'user-bad' });
  check('用户 Key 无效 → USER_KEY_INVALID', r.json.ok === false && r.json.error === 'USER_KEY_INVALID');
  r = await call({ action: 'session' });
  const sess3 = r.json.session;
  await call({ action: 'chat', prompt: 'hi' }, { 'X-User-Key': 'user-good', 'X-Demo-Token': process.env.DEMO_TOKEN, 'X-Demo-Session': sess3 });
  r = await call({ action: 'chat', prompt: 'hi' }, { 'X-Demo-Token': process.env.DEMO_TOKEN, 'X-Demo-Session': sess3 });
  check('user 路径不消耗演示额度', r.json.ok === true && r.json.remaining === 4);

  console.log('== IP 每日演示上限 ==');
  process.env.IP_DAILY_LIMIT = '1';
  r = await call({ action: 'session' }, {}, 'POST', '8.8.8.8');
  const sess4 = r.json.session;
  const h4 = { 'X-Demo-Token': process.env.DEMO_TOKEN, 'X-Demo-Session': sess4 };
  r = await call({ action: 'chat', prompt: 'hi' }, h4, 'POST', '8.8.8.8');
  check('该 IP 第 1 次成功', r.json.ok === true);
  r = await call({ action: 'chat', prompt: 'hi' }, h4, 'POST', '8.8.8.8');
  check('超出 IP 每日上限 → 429 IP_DAILY_LIMITED', r.status === 429 && r.json.error === 'IP_DAILY_LIMITED');
  delete process.env.IP_DAILY_LIMIT;

  console.log('== IP 限流 ==');
  process.env.RATE_LIMIT_PER_HOUR = String(posts); // 下一次 POST 计数 posts+1 > posts，即超限
  r = await call({ action: 'session' });
  check('超限 → 429 RATE_LIMITED', r.status === 429 && r.json.error === 'RATE_LIMITED');
  process.env.RATE_LIMIT_PER_HOUR = '1000';
  r = await call({ action: 'session' });
  check('恢复限额后正常', r.status === 200 && r.json.ok === true);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  mock.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(1);
});

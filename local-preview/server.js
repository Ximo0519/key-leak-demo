'use strict';
/**
 * 本地预览服务器：node server.js [--port 5173]
 * --------------------------------------------------------------
 * 等价模拟 CloudBase 部署后的环境，方便「先本地跑通再上云」：
 *   - 静态目录 ../web        -> 页面（同源）
 *   - POST/GET /api/proxy    -> 云函数（同一份 index.js 代码）
 *
 * 未设置 UPSTREAM_API_KEY 时自动启动内置 mock 上游（不花钱、不联网），
 * 其中 Key 填 "user-429" 可模拟个人额度耗尽、"user-bad" 模拟无效 Key。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.DEMO_TOKEN = process.env.DEMO_TOKEN || 'demo_fish_ep03_change_me';
process.env.DEMO_DAILY_LIMIT = process.env.DEMO_DAILY_LIMIT || '5';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'local-preview-secret';

const PORT_IDX = process.argv.indexOf('--port');
const PORT = Number(PORT_IDX > -1 ? process.argv[PORT_IDX + 1] : process.env.PORT || 5173);
const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/* ---------- 内置 mock 上游（未配置真 Key 时启用） ---------- */
function startMockUpstream() {
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      if (auth === 'Bearer user-429') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'quota exhausted' } }));
      }
      if (auth === 'Bearer user-bad') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid key' } }));
      }
      let prompt = '';
      try {
        const msgs = JSON.parse(body).messages || [];
        prompt = (msgs[msgs.length - 1] || {}).content || '';
      } catch (_) { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '（本地 mock）就凭「' + prompt.slice(0, 20) + '」这件事，大肥鱼说你今天已经赢了！' } }],
      }));
    });
  });
  return new Promise((resolve) => {
    mock.listen(0, '127.0.0.1', () => {
      process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;
      process.env.UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || 'sk-local-mock';
      console.log('[preview] 未检测到 UPSTREAM_API_KEY，已启用内置 mock 上游（Key 填 user-429/user-bad 可模拟耗尽/无效）');
      resolve();
    });
  });
}

const { main } = require(path.join('..', 'functions', 'proxy', 'index.js'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/proxy') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const event = {
        httpMethod: req.method,
        headers: req.headers,
        body,
        isBase64Encoded: false,
        requestContext: { sourceIp: req.socket.remoteAddress || 'local' },
      };
      try {
        const out = await main(event, {});
        res.writeHead(out.statusCode, out.headers);
        res.end(out.body || '');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'FUNCTION_CRASH', detail: String(e) }));
      }
    });
    return;
  }

  const p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(WEB_DIR, p));
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

(async () => {
  if (!process.env.UPSTREAM_API_KEY) await startMockUpstream();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[preview] 本地预览：http://127.0.0.1:${PORT}  （Ctrl+C 退出）`);
  });
})();

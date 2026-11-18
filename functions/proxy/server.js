'use strict';
/**
 * Web 函数启动包装：把 HTTP 请求转成 exports.main(event) 的事件格式，
 * 再把 {statusCode, headers, body} 写回响应。index.js 逻辑零改动。
 */
const http = require('http');
const { main } = require('./index');

const PORT = parseInt(process.env.PORT || process.env.SCF_RUNTIME_PORT || '9000', 10);

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const event = {
          httpMethod: req.method,
          headers: req.headers || {},
          body: Buffer.concat(chunks).toString('utf8'),
          isBase64Encoded: false,
          requestContext: {
            sourceIp:
              (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
              req.socket.remoteAddress ||
              'unknown',
          },
        };
        const out = await main(event);
        res.writeHead(out.statusCode || 500, out.headers || {});
        res.end(out.body || '');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'INTERNAL', message: String((e && e.message) || e) }));
      }
    });
  })
  .listen(PORT, '0.0.0.0', () => console.log('proxy web server listening on ' + PORT));

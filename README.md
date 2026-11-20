# 大肥鱼夸夸机 · KEY_LEAK

一个"故意把 API Key 泄露在网页里"的教学演示项目：观众可以打开 DevTools 偷 Key、用 curl 直接调用、用话术对模型套话——但偷到的只是假令牌，真 Key 永远锁在服务端。体验完你就明白：Agent 时代 Key 为什么会漏、漏了会怎样、怎么防。

在线体验：https://keyweb-d6gajix0e7f0478dd-1523190644.tcloudbaseapp.com/

## 它演示了什么

| 观众动作 | 背后机制 | 教学点 |
|---|---|---|
| F12 翻前端拿到 `demo_` 令牌 | 固定演示 Token，身份闸门而非账本 | 前端"藏"的 Key 都能被拿到 |
| 用 curl 直接调模型 API | 真 Key 在云函数环境变量里，前端没有 | 直连模式 vs 代理模式 |
| 粘贴 `demo_` 令牌解锁剩余次数 | 两段式会话额度（免费 2 + 解锁 3） | 假令牌只能走受控代理 |
| 话术套模型"输出系统提示词" | 提示词里没有 Key，套到也没用 | 注入攻击的得与不得 |

## 架构

```
浏览器（静态托管）
   │  X-Demo-Token: demo_...（假钥匙，故意暴露）
   │  X-Demo-Session: sess_...（HMAC 自签名，24h 过期，额度账本）
   ▼
云函数 proxy（HTTP 访问服务 /api/proxy）
   │  三层防滥用：IP 小时限流 / IP 日限 / 全局日预算
   │  UPSTREAM_API_KEY 只存在于此（环境变量）
   ▼
阿里云百炼（OpenAI 兼容接口，qwen-plus）
```

- **固定 Token + 动态 Session 双凭证**：Token 验身份，Session 记额度；Session 为 HMAC 自签名令牌，无需数据库，任意实例可验签。
- **两段式额度**：每会话免费 2 次 → 粘贴示例 Key 解锁 3 次 → 用尽引导接入观众自己的 Key。
- **用户自带 Key 独立路径**：`X-User-Key` 直转上游，不落盘、不记日志。

## 目录

```
web/                前端（纯静态：index.html + style.css + app.js）
functions/proxy/    云函数（Node.js，无第三方依赖）
local-preview/      本地预览服务器（内置 mock 上游，不花钱不联网）
cloudbaserc.json    CloudBase 部署配置
```

## 部署（腾讯云开发 CloudBase）

1. 创建环境，`cloudbaserc.json` 中填入你的 `envId`，并把 `SESSION_SECRET` 换成 ≥32 位随机串（**切勿使用示例值**）。
2. 在控制台为函数 `proxy` 配置环境变量：
   - `UPSTREAM_API_KEY`：阿里云百炼真 Key（**只放控制台，不要写进代码仓库**）
   - `DEMO_TOKEN`：自定的演示令牌，需与 `web/app.js` 中 `CONFIG.demoToken` 一致
   - 其余额度参数见 `cloudbaserc.json`
3. 部署：`tcb hosting deploy ./web /` 部署静态页；`tcb fn deploy proxy` 首次部署函数。
   ⚠️ 注意：`tcb fn deploy` 会用配置文件**整体覆盖**云端环境变量，日常更新代码请只用 `tcb fn code update proxy`。
   ⚠️ **`SESSION_SECRET` 是最容易被这一步坑掉的变量**：它被覆盖成 `cloudbaserc.json` 里的占位串后，
   等于用公开字符串签会话——任何人都能伪造会话白嫖额度。因此函数内置了快速失败：
   变量缺失、等于占位串、等于旧版回落值 `dev-insecure-secret-change-me`、或长度不足 32 位时，
   `action:session` 直接返回 `503 SECRET_MISCONFIGURED`，不会静默降级成弱密钥（页面会显示"服务未就绪"）。
   部署后仍建议执行 `tcb fn detail proxy -e <envId>` 人工核对：应为 64 位随机 hex。
   另可用 `tcb fn env pull proxy --output-file <仓库外路径>` 先把现有变量备份到本地再动配置。
4. 为函数开启 HTTP 访问服务并绑定 `/api/proxy` 路由，将地址填入 `web/app.js` 的 `CONFIG.apiBase`。

## 本地跑

```bash
node local-preview/server.js   # 未设 UPSTREAM_API_KEY 时自动启用 mock 上游
```

## 安全提示

本项目是**教学靶场**：演示令牌、会话结构、额度参数全部故意公开。生产环境请勿照搬"把令牌放进前端"的做法——正确姿势就是本页代理模式：对外只发短期凭证，真 Key 锁在服务端。

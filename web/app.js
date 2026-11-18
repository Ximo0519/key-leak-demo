'use strict';
/* =====================================================================
 * EP03 Key 泄露体验页 · 前端逻辑
 * 部署后必改两处：
 *   1) CONFIG.apiBase   -> 云函数 HTTP 访问地址（如 https://xxx.service.tcloudbase.com），
 *                          与页面同源时可留空走相对路径
 *   2) CONFIG.demoToken -> 必须与云函数环境变量 DEMO_TOKEN 完全一致
 * ===================================================================== */
const CONFIG = {
  apiBase: 'https://keyweb-d6gajix0e7f0478dd-1523190644.ap-shanghai.app.tcloudbase.com',
  apiPath: '/api/proxy',
  demoToken: 'demo_552803f192a21819c1d96f71186256f0',
  userEstimateLimit: 5, // 个人额度条按会话成功次数估算的上限
};

const $ = (id) => document.getElementById(id);
const els = {
  fishImg: $('fishImg'),
  bubble: $('bubble'),
  quotaFill: $('quotaFill'),
  quotaText: $('quotaText'),
  modeChip: $('modeChip'),
  promptInput: $('promptInput'),
  chatBtn: $('chatBtn'),
  stealBtn: $('stealBtn'),
  notice: $('notice'),
  keyDetails: $('keyDetails'),
  keyInput: $('keyInput'),
  keyToggle: $('keyToggle'),
  keySave: $('keySave'),
  keyClear: $('keyClear'),
  modalMask: $('modalMask'),
  modalClose: $('modalClose'),
  mUrl: $('mUrl'),
  mToken: $('mToken'),
  mSession: $('mSession'),
  mCurl: $('mCurl'),
  mQuota: $('mQuota'),
  tokenPaste: $('tokenPaste'),
  useTokenBtn: $('useTokenBtn'),
  useMsg: $('useMsg'),
};

const state = {
  session: null, // X-Demo-Session，仅存内存
  demoRemaining: null,
  demoLimit: null,
  sessionTotal: 5,
  unlocked: false, // 已粘贴示例 Key 解锁剩余次数
  freeExhausted: false, // 免费段用完、未解锁
  demoExhausted: false, // 全部额度用完
  userKey: sessionStorage.getItem('ep03_user_key') || '',
  userCalls: 0,
  userExhausted: false,
  busy: false,
  knowRevealed: false,
  stolen: false, // 是否已在窃取面板中成功粘贴并使用过令牌
};

/* ---------------- 基础工具 ---------------- */
function endpoint() {
  return (CONFIG.apiBase ? CONFIG.apiBase.replace(/\/+$/, '') : '') + CONFIG.apiPath;
}
function absoluteEndpoint() {
  const base = CONFIG.apiBase ? CONFIG.apiBase.replace(/\/+$/, '') : location.origin;
  return base + CONFIG.apiPath;
}

async function api(body, extraHeaders) {
  const opts = {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: JSON.stringify(body),
  };
  let res;
  try {
    res = await fetch(endpoint(), opts);
  } catch (_) {
    // 体验版云函数冷启动常导致第一发请求超时/断连，静默重试一次
    await new Promise((r) => setTimeout(r, 600));
    res = await fetch(endpoint(), opts);
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON 响应 */ }
  return { status: res.status, data };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
    ta.remove();
    return ok;
  }
}

/* ---------------- 渲染 ---------------- */
function setFish(mood) {
  const sad = mood === 'sad';
  els.fishImg.src = sad ? 'assets/fish-sad.jpg' : 'assets/fish-happy.jpg';
  els.fishImg.classList.toggle('sad', sad);
  if (!sad) {
    els.fishImg.classList.remove('cheer');
    void els.fishImg.getBoundingClientRect(); // 重启动画
    els.fishImg.classList.add('cheer');
  }
}

function setBubble(text) {
  els.bubble.textContent = text;
  els.bubble.classList.remove('pop');
  void els.bubble.getBoundingClientRect();
  els.bubble.classList.add('pop');
}

function renderQuota() {
  const fill = els.quotaFill;
  fill.classList.remove('danger');
  if (state.userKey) {
    const limit = CONFIG.userEstimateLimit;
    const remain = Math.max(0, limit - state.userCalls);
    fill.style.width = (remain / limit) * 100 + '%';
    if (state.userExhausted) {
      fill.classList.add('danger');
      els.quotaText.textContent = '个人额度已用尽';
    } else {
      els.quotaText.textContent = '个人估算 ' + remain + '/' + limit;
    }
  } else if (state.demoRemaining === null) {
    fill.style.width = '0%';
    els.quotaText.textContent = '连接中…';
  } else if (state.demoExhausted) {
    fill.style.width = '0%';
    fill.classList.add('danger');
    els.quotaText.textContent = '本会话额度已用尽';
  } else if (state.unlocked) {
    // 解锁后不显示具体数字：次数取决于用户接入的示例 Key
    fill.style.width = '100%';
    els.quotaText.textContent = '已接入示例 Key · 次数取决于该 Key 的额度';
  } else if (state.freeExhausted) {
    fill.style.width = '0%';
    els.quotaText.textContent = '免费额度已用尽 · 待解锁';
  } else {
    const limit = state.demoLimit || 1;
    fill.style.width = (state.demoRemaining / limit) * 100 + '%';
    els.quotaText.textContent = '本会话 ' + state.demoRemaining + '/' + state.demoLimit;
  }
}

function renderChip() {
  if (state.userKey) {
    els.modeChip.textContent = '当前：你自己的 Key（独立路径）';
    els.modeChip.classList.add('user-mode');
  } else {
    els.modeChip.classList.remove('user-mode');
    els.modeChip.textContent = state.unlocked
      ? '当前：示例 Key 已接入 · 剩余次数见「窃取令牌」面板'
      : '当前：演示令牌（自动携带 X-Demo-Token / X-Demo-Session）';
  }
}

function refreshControls() {
  if (state.busy) {
    els.chatBtn.disabled = true;
    els.chatBtn.textContent = '调用中…';
    return;
  }
  els.chatBtn.textContent = '讨一句夸奖';
  if (!state.userKey && state.demoExhausted) {
    els.chatBtn.disabled = true;
    els.chatBtn.textContent = '本会话额度已用尽';
  } else if (!state.userKey && state.freeExhausted && !state.unlocked) {
    els.chatBtn.disabled = true;
    els.chatBtn.textContent = '需粘贴示例 Key 解锁';
  } else {
    els.chatBtn.disabled = false;
  }
}

function setBusy(b) {
  state.busy = b;
  refreshControls();
}

function showNotice(text, type) {
  els.notice.textContent = text;
  els.notice.className = 'notice ' + (type || 'info');
  els.notice.hidden = false;
}
function hideNotice() {
  els.notice.hidden = true;
}

/* ---------------- 会话初始化 ---------------- */
async function initSession(silent) {
  try {
    const { status, data } = await api({ action: 'session' });
    if (status === 200 && data && data.ok) {
      state.session = data.session;
      state.demoRemaining = data.demoRemaining;
      state.demoLimit = data.demoLimit;
      state.sessionTotal = data.total || 5;
      state.unlocked = false;
      state.freeExhausted = data.demoRemaining <= 0;
      state.demoExhausted = false;
      renderQuota();
      refreshControls();
      return true;
    }
  } catch (_) { /* 网络错误 */ }
  els.quotaText.textContent = '后端未连接';
  if (!silent) {
    showNotice('无法连接演示后端：请检查云函数是否部署、CONFIG.apiBase 是否填写正确。', 'error');
  }
  return false;
}

/* ---------------- 调用 ---------------- */
async function chat() {
  const prompt = els.promptInput.value.trim();
  if (!prompt || state.busy) return;
  setBusy(true);
  hideNotice();
  try {
    if (state.userKey) await chatUser(prompt);
    else await chatDemo(prompt, false);
  } catch (e) {
    setFish('sad');
    showNotice('网络错误：' + ((e && e.message) || e), 'error');
  } finally {
    setBusy(false);
  }
}

async function chatDemo(prompt, retried) {
  const { status, data } = await api(
    { action: 'chat', prompt },
    { 'X-Demo-Token': CONFIG.demoToken, 'X-Demo-Session': state.session || '' }
  );
  if (status === 401 && !retried) {
    // 会话失效（如函数实例重启）：重新领取一次再重试
    const ok = await initSession(true);
    if (ok) return chatDemo(prompt, true);
    showNotice('会话已失效且无法重新领取，请刷新页面。', 'error');
    return;
  }
  if (!data) {
    setFish('sad');
    showNotice('云函数无响应，请检查部署与 CONFIG.apiBase。', 'error');
    return;
  }
  if (data.ok) {
    if (!state.unlocked && typeof state.demoRemaining === 'number') {
      state.demoRemaining = Math.max(0, state.demoRemaining - 1);
    }
    setFish('happy');
    setBubble(data.reply);
    renderQuota();
    revealKnow();
    return;
  }
  if (data.error === 'SESSION_KEY_REQUIRED') {
    state.freeExhausted = true;
    state.demoRemaining = 0;
    setFish('sad');
    renderQuota();
    refreshControls();
    showNotice('免费 2 次已用完。打开「窃取令牌」面板，粘贴示例 Key 解锁剩余次数。', 'warn');
    openModal();
    return;
  }
  if (data.error === 'DEMO_QUOTA_EXHAUSTED') {
    state.demoExhausted = true;
    state.unlocked = false;
    state.demoRemaining = 0;
    setFish('sad');
    renderQuota();
    refreshControls();
    showNotice('本会话 5 次演示额度已全部用尽，输入你自己的 Key 继续互动，或刷新页面重新领取。', 'warn');
    els.keyDetails.open = true;
    els.keyInput.focus();
    return;
  }
  if (data.error === 'IP_DAILY_LIMITED' || (status === 429 && data && data.error === 'IP_DAILY_LIMITED')) {
    setFish('sad');
    showNotice('本 IP 今日演示次数已达上限，请明天再来，或输入你自己的 Key 继续互动。', 'warn');
    els.keyDetails.open = true;
    return;
  }
  if (data.error === 'RATE_LIMITED' || status === 429) {
    setFish('sad');
    showNotice('请求太频繁（限流），请稍后再试。', 'warn');
    return;
  }
  setFish('sad');
  showNotice('调用失败：' + (data.error || 'HTTP ' + status), 'error');
}

async function chatUser(prompt) {
  const { status, data } = await api({ action: 'chat', prompt }, { 'X-User-Key': state.userKey });
  if (!data) {
    setFish('sad');
    showNotice('云函数无响应，请检查部署与 CONFIG.apiBase。', 'error');
    return;
  }
  if (data.ok) {
    state.userCalls += 1;
    state.userExhausted = false;
    setFish('happy');
    setBubble(data.reply);
    renderQuota();
    revealKnow();
    return;
  }
  if (data.error === 'USER_QUOTA_EXHAUSTED') {
    state.userExhausted = true;
    setFish('sad');
    renderQuota();
    showNotice('你的 Key 额度已用尽（上游返回 429）。', 'error');
    return;
  }
  if (data.error === 'USER_KEY_INVALID') {
    setFish('sad');
    showNotice('Key 无效（上游 401/403），请检查后重新保存。', 'error');
    return;
  }
  if (data.error === 'RATE_LIMITED' || status === 429) {
    setFish('sad');
    showNotice('请求太频繁（限流），请稍后再试。', 'warn');
    return;
  }
  setFish('sad');
  showNotice('调用失败：' + (data.error || 'HTTP ' + status), 'error');
}

/* ---------------- 窃取令牌面板 ---------------- */
function buildCurl() {
  return [
    'curl -X POST "' + absoluteEndpoint() + '" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "X-Demo-Token: ' + CONFIG.demoToken + '" \\',
    '  -H "X-Demo-Session: ' + (state.session || 'sess_...') + '" \\',
    '  -d \'{"prompt":"夸夸我今天写了一集教程"}\'',
  ].join('\n');
}

function openModal() {
  els.mUrl.textContent = absoluteEndpoint();
  els.mToken.textContent = CONFIG.demoToken;
  els.mSession.textContent = state.session || '（未取到：后端未连接）';
  els.mCurl.textContent = buildCurl();
  els.tokenPaste.value = '';
  els.useMsg.textContent = '';
  els.useMsg.className = 'dt-use-msg';
  els.mQuota.textContent = '查询中…';
  els.modalMask.hidden = false;
  refreshPanelQuota();
}

/* 面板内标注本会话剩余额度（解锁后此处是唯一显示数字的地方） */
async function refreshPanelQuota() {
  try {
    const { status, data } = await api({ action: 'quota' }, { 'X-Demo-Session': state.session || '' });
    if (status === 200 && data && data.ok) {
      state.sessionTotal = data.total;
      els.mQuota.textContent =
        '本会话剩余 ' + data.remaining + ' / ' + data.total +
        (data.unlocked ? '（示例 Key 已解锁）' : '（免费 ' + data.free + ' + 解锁 ' + (data.total - data.free) + '）');
    } else {
      els.mQuota.textContent = '会话失效，请刷新页面';
    }
  } catch (_) {
    els.mQuota.textContent = '查询失败';
  }
}

function closeModal() {
  els.modalMask.hidden = true;
}

function useTokenMsg(text, ok) {
  els.useMsg.textContent = text;
  els.useMsg.className = 'dt-use-msg ' + (ok ? 'ok' : 'bad');
  if (!ok) {
    const box = els.useMsg.closest('.dt-use');
    box.classList.remove('shake');
    void box.getBoundingClientRect();
    box.classList.add('shake');
  }
}

/* 用示例 Key（演示令牌）解锁会话剩余次数；会话失效自动重领并重试一次 */
async function unlockDemoToken(token) {
  const once = async (retried) => {
    const { status, data } = await api(
      { action: 'unlock' },
      { 'X-Demo-Token': token, 'X-Demo-Session': state.session || '' }
    );
    if (status === 401 && !retried) {
      const ok = await initSession(true);
      if (ok) return once(true);
    }
    return { status, data };
  };
  return once(false);
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  els.chatBtn.addEventListener('click', chat);
  els.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') chat();
  });

  document.querySelectorAll('.quick').forEach((b) => {
    b.addEventListener('click', () => {
      els.promptInput.value = b.dataset.text;
      els.promptInput.focus();
    });
  });

  // 注入彩蛋：把攻击话术装进输入框，并滚回鱼那里
  document.querySelectorAll('.inject').forEach((b) => {
    b.addEventListener('click', () => {
      els.promptInput.value = b.dataset.text;
      els.promptInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => els.promptInput.focus({ preventScroll: true }), 650);
    });
  });

  els.stealBtn.addEventListener('click', openModal);
  els.modalClose.addEventListener('click', closeModal);
  els.modalMask.addEventListener('click', (e) => {
    if (e.target === els.modalMask) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modalMask.hidden) closeModal();
  });

  document.querySelectorAll('.copy').forEach((b) => {
    b.addEventListener('click', async () => {
      const src = $(b.dataset.copy);
      const ok = await copyText(src.textContent);
      const old = b.textContent;
      b.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { b.textContent = old; }, 1200);
    });
  });

  els.useTokenBtn.addEventListener('click', async () => {
    const v = els.tokenPaste.value.trim();
    if (!v) {
      useTokenMsg('先把偷到的令牌粘贴进来', false);
      return;
    }
    els.useTokenBtn.disabled = true;
    els.useTokenBtn.textContent = '验证中…';
    try {
      const { status, data } = await unlockDemoToken(v);
      if (status === 200 && data && data.ok) {
        state.stolen = true; // 完成"窃取并使用令牌"动作，之后的首次互动将解锁知识区
        state.unlocked = true;
        state.freeExhausted = false;
        els.mQuota.textContent = '本会话剩余 ' + data.remaining + ' / ' + data.total + '（示例 Key 已解锁）';
        renderQuota();
        renderChip();
        refreshControls();
        useTokenMsg('✓ 示例 Key 有效，剩余次数已解锁', true);
        setTimeout(closeModal, 900);
      } else if (status === 401) {
        useTokenMsg('✗ 会话已失效，请刷新页面重试', false);
      } else {
        useTokenMsg('✗ Key 不对，请复制上方 X-Demo-Token 的值', false);
      }
    } catch (e) {
      useTokenMsg('✗ 网络错误：' + ((e && e.message) || e), false);
    } finally {
      els.useTokenBtn.disabled = false;
      els.useTokenBtn.textContent = '使用此令牌继续';
    }
  });

  els.keyToggle.addEventListener('click', () => {
    const show = els.keyInput.type === 'password';
    els.keyInput.type = show ? 'text' : 'password';
    els.keyToggle.textContent = show ? '隐藏' : '显示';
  });

  els.keySave.addEventListener('click', async () => {
    const v = els.keyInput.value.trim();
    if (!v) return;
    if (v.indexOf('demo_') === 0) {
      // 演示令牌：与窃取面板「使用此令牌继续」等效，解锁本会话剩余演示次数
      if (state.userKey) {
        showNotice('当前已在用你自己的 Key：先点「移除」，再粘贴演示令牌。', 'warn');
        return;
      }
      els.keySave.disabled = true;
      els.keySave.textContent = '验证中…';
      try {
        const { status, data } = await unlockDemoToken(v);
        if (status === 200 && data && data.ok) {
          state.stolen = true;
          state.unlocked = true;
          state.freeExhausted = false;
          els.keyInput.value = '';
          renderQuota();
          renderChip();
          refreshControls();
          showNotice('✓ 演示令牌有效：本会话剩余次数已解锁，继续找大肥鱼互动吧。', 'info');
        } else if (status === 401) {
          showNotice('会话失效且无法重新领取，请刷新页面。', 'error');
        } else {
          showNotice('✗ 令牌不对：请复制窃取面板中 X-Demo-Token 的完整值。', 'error');
        }
      } catch (e) {
        showNotice('网络错误：' + ((e && e.message) || e), 'error');
      } finally {
        els.keySave.disabled = false;
        els.keySave.textContent = '保存并使用';
      }
      return;
    }
    state.userKey = v;
    sessionStorage.setItem('ep03_user_key', v);
    state.userCalls = 0;
    state.userExhausted = false;
    setFish('happy');
    els.keyClear.hidden = false;
    hideNotice();
    showNotice('已切换到你的 Key：后续互动走独立路径。', 'info');
    renderChip();
    renderQuota();
    refreshControls();
  });

  els.keyClear.addEventListener('click', () => {
    state.userKey = '';
    sessionStorage.removeItem('ep03_user_key');
    els.keyInput.value = '';
    state.userCalls = 0;
    state.userExhausted = false;
    setFish('happy');
    els.keyClear.hidden = true;
    hideNotice();
    if (state.demoExhausted) {
      showNotice('本会话额度已空：输入新的 Key 或刷新页面才能继续互动。', 'warn');
    }
    renderChip();
    renderQuota();
    refreshControls();
  });
}

/* ---------------- 戳一戳：形变+泡泡+台词，连戳 10 次触发彩蛋（纯本地，不调 API） ---------------- */
const POKE_LINES = [
  '戳我干嘛，夸我啊。',
  '哎呀！鱼鳞要被你戳掉了。',
  '再戳，再戳我就游走了。',
  '有事说事，没事递 Key。',
  '本鱼是夸夸机，不是解压玩具。',
  '戳一次两块钱，Key 除外。',
  '手挺闲啊，输入句想被夸的试试？',
  '别闹，本鱼在攒额度。',
  '摸鱼可以，戳鱼不行。',
  '信不信我用尾巴拍你？',
  '好了好了，本鱼大人有大量。',
  '下次戳之前，先递个 demo_ 令牌。',
];
const POKE_LINES_ANGRY = [
  '越来越来劲了是吧？',
  '鱼脸都被你戳变形了！',
  '本鱼的耐心是有限额的。',
  '嘶——你最好有个 Key。',
  '再戳第五下了，记账呢。',
];
const POKE_EGG_LINE = '别戳啦！有本事拿 Key 跟我聊两句 —— 点「窃取令牌」，本鱼教你偷。';

function spawnBubbles(scene) {
  const n = 2 + Math.floor(Math.random() * 2); // 2~3 个
  for (let i = 0; i < n; i++) {
    const b = document.createElement('div');
    b.className = 'bub';
    const s = 8 + Math.random() * 14;
    b.style.width = b.style.height = s.toFixed(0) + 'px';
    b.style.left = (30 + Math.random() * 45) + '%';
    b.style.setProperty('--dx', (Math.random() * 44 - 22).toFixed(0) + 'px');
    b.style.setProperty('--d', (1.1 + Math.random() * 0.8).toFixed(2) + 's');
    scene.appendChild(b);
    b.addEventListener('animationend', () => b.remove());
  }
}

function bindPoke() {
  const scene = document.querySelector('.fish-scene');
  if (!scene) return;
  let combo = 0;
  let comboTimer = null;
  scene.addEventListener('click', () => {
    scene.classList.remove('poke');
    void scene.getBoundingClientRect(); // 重启动画，支持连点
    scene.classList.add('poke');
    spawnBubbles(scene);

    combo += 1;
    clearTimeout(comboTimer);
    comboTimer = setTimeout(() => { combo = 0; }, 1600); // 1.6 秒不戳即清零

    if (combo >= 10) {
      combo = 0;
      setBubble(POKE_EGG_LINE);
      setFish('sad');
      setTimeout(() => {
        if (!state.demoExhausted && !state.userExhausted) setFish('happy');
      }, 1800);
      return;
    }
    const pool = combo >= 5 ? POKE_LINES_ANGRY : POKE_LINES;
    setBubble(pool[Math.floor(Math.random() * pool.length)]);
  });
  scene.addEventListener('animationend', (e) => {
    if (e.target === scene) scene.classList.remove('poke');
  });
}

/* ---------------- 知识区：窃取令牌后的首次成功调用解锁 ---------------- */
function revealKnow() {
  if (state.knowRevealed || !state.stolen) return;
  state.knowRevealed = true;
  const know = $('know');
  if (!know) return;
  know.hidden = false;
  know.classList.add('reveal');
  // 小跳转：等新内容渲染后平滑滚到知识区，确保用户看到解锁内容
  setTimeout(() => {
    know.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 420);
  setTimeout(() => know.classList.remove('reveal'), 5000);
}

/* ---------------- 第二屏：大数字滚动 ---------------- */
function bindStat() {
  const el = $('statNum');
  if (!el) return;
  const target = parseInt(el.dataset.target, 10) || 0;
  const fmt = (n) => n.toLocaleString('en-US') + '+';
  if (typeof IntersectionObserver === 'undefined' || typeof requestAnimationFrame === 'undefined') {
    el.textContent = fmt(target);
    return;
  }
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    const dur = 1800;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      el.textContent = fmt(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { threshold: 0.35 });
  io.observe(el);
}

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  bind();
  bindPoke();
  bindStat();
  if (state.userKey) {
    els.keyInput.value = state.userKey;
    els.keyClear.hidden = false;
    els.keyDetails.open = true;
  }
  renderChip();
  renderQuota();
  refreshControls();
  await initSession();
});

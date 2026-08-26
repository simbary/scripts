// ==UserScript==
// @name         partyscape自动脚本
// @namespace    partyscape
// @version      1.05
// @author       Codex
// @description  自动执行界面一些操作
// @downloadURL  https://raw.githubusercontent.com/simbary/scripts/main/partyscape.user.js
// @updateURL    https://raw.githubusercontent.com/simbary/scripts/main/partyscape.user.js
// @match        https://partyscape.club/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var PREFIX = '[Partyscape]';
  var STORAGE_KEY = 'partyscape_auto_enabled';
  var MIN_KEY = 'partyscape_panel_minimized';

  var running = false;
  var minimized = false;
  var observer = null;
  var pollTimer = null;
  var loginAbort = false;

  var lastRewardTime = '';
  var lastRewardContent = '';
  var lastBossLootTime = '';
  var lastBossLootContent = '';
  var lastBossLootSignature = '';

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function nowTimeString() {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function findButtonByText(text) {
    var target = text.replace(/\s+/g, ' ').trim();
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < buttons.length; i++) {
      var t = (buttons[i].innerText || '').replace(/\s+/g, ' ').trim();
      if (t === target) return buttons[i];
    }
    return null;
  }

  function findButtonContaining(text) {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < buttons.length; i++) {
      var t = buttons[i].innerText || '';
      if (t.indexOf(text) !== -1) return buttons[i];
    }
    return null;
  }

  // ============ 自动登录 ============
  async function autoLogin() {
    for (var i = 0; i < 100; i++) {
      if (loginAbort || !running) return;

      if (findButtonByText('冒险')) {
        console.log(PREFIX + ' 已进入游戏');
        return;
      }

      var cont = findButtonContaining('继续');
      if (cont) {
        console.log(PREFIX + ' 点击「继续」进入登录流程');
        cont.click();
        await sleep(1500);
        continue;
      }

      var enter = findButtonByText('进入世界');
      if (enter) {
        var pwd = document.querySelector('input[type="password"]');
        if (pwd && pwd.value && pwd.value.trim()) {
          console.log(PREFIX + ' 密码已填充，点击「进入世界」登录');
          enter.click();
          await sleep(2500);
          continue;
        } else {
          console.log(PREFIX + ' 密码为空，自动登录已暂停，等待手动登录（不会以访客身份进入）');
          return;
        }
      }

      await sleep(500);
    }
  }

  // ============ 奖励弹窗监控 ============
  function getRewardPopup() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
    var claimBtn = null;
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b.disabled) continue;
      var t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      if (t === '领取' || t === 'Claim') {
        claimBtn = b;
        break;
      }
    }
    if (!claimBtn) return null;

    var popup = claimBtn;
    while (popup && popup.parentElement) {
      var cls = String(popup.className || '');
      if (cls.indexOf('fixed') !== -1 && (cls.indexOf('z-40') !== -1 || cls.indexOf('z-[90]') !== -1)) break;
      popup = popup.parentElement;
    }
    if (!popup || popup === document.body || popup === document.documentElement) return null;

    var title = '';
    var desc = '';
    var reward = '';
    var titleEl = popup.querySelector('span.font-bold.text-gold');
    var descEl = popup.querySelector('p.text-xs.opacity-70');
    var rewardEl = popup.querySelector('span.text-gold.font-semibold');
    if (titleEl) title = titleEl.textContent.trim();
    if (descEl) desc = descEl.textContent.trim();
    if (rewardEl) reward = rewardEl.textContent.trim();

    if (!title && !reward) return null;

    return { popup: popup, claimBtn: claimBtn, title: title, desc: desc, reward: reward };
  }

  var lastClaimAt = 0;
  function handleRewardPopup() {
    if (!running) return false;

    var info = getRewardPopup();
    if (!info) return false;

    var now = Date.now();
    if (now - lastClaimAt < 1500) return false;
    lastClaimAt = now;

    console.log(PREFIX + ' 🎁 检测到奖励弹窗');
    console.log(PREFIX + '   标题: ' + info.title);
    console.log(PREFIX + '   描述: ' + info.desc);
    console.log(PREFIX + '   收益: ' + info.reward);

    info.claimBtn.click();

    var parts = [];
    if (info.title) parts.push(info.title);
    if (info.reward) parts.push(info.reward);
    lastRewardTime = nowTimeString();
    lastRewardContent = parts.join(' · ') || info.desc || '奖励';
    updateLastReward();

    console.log(PREFIX + '   已点击「领取」按钮');
    return true;
  }

  // ============ 首领自动攻击 ============
  function findBossAttackButton() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b.disabled) continue;
      var cls = String(b.className || '');
      if (cls.indexOf('min-w-[280px]') === -1) continue;
      var t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      if (t === '攻击！' || t === 'Attack') return b;
    }
    return null;
  }

  var lastAttackAt = 0;
  function handleBossAttack() {
    if (!running) return false;

    var btn = findBossAttackButton();
    if (!btn) return false;

    var now = Date.now();
    if (now - lastAttackAt < 3000) return false;
    lastAttackAt = now;

    console.log(PREFIX + ' ⚔️ 检测到首领已开放，点击「攻击！」');
    btn.click();
    return true;
  }

  // ============ 升级弹窗处理 ============
  function findLevelUpContinueButton() {
    var titles = document.querySelectorAll('div.font-display.text-3xl');
    for (var i = 0; i < titles.length; i++) {
      var title = titles[i];
      if ((title.innerText || '').indexOf('升级了') === -1) continue;

      var modal = title;
      while (modal && modal.parentElement) {
        var cls = String(modal.className || '');
        if (cls.indexOf('fixed') !== -1 && cls.indexOf('inset-0') !== -1) break;
        modal = modal.parentElement;
      }
      if (!modal || modal === document.body || modal === document.documentElement) continue;

      var buttons = modal.querySelectorAll('button');
      for (var j = 0; j < buttons.length; j++) {
        var b = buttons[j];
        if (b.disabled) continue;
        var t = (b.innerText || '').replace(/\s+/g, ' ').trim();
        if (t === '继续' || t === 'Continue') return b;
      }
    }
    return null;
  }

  var lastLevelUpAt = 0;
  function handleLevelUpPopup() {
    if (!running) return false;

    var btn = findLevelUpContinueButton();
    if (!btn) return false;

    var now = Date.now();
    if (now - lastLevelUpAt < 500) return false;
    lastLevelUpAt = now;

    console.log(PREFIX + ' ⬆️ 检测到「升级了」弹窗，点击「继续」');
    btn.click();
    return true;
  }

  // ============ 首领战利品读取 ============
  function isBossAttacking() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var cls = String(b.className || '');
      if (cls.indexOf('min-w-[280px]') === -1) continue;
      var t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.indexOf('自动攻击') !== -1 || t.indexOf('Auto') !== -1) return true;
    }
    return false;
  }

  function getBossLoot() {
    var descEl = null;
    var candidates = document.querySelectorAll('div.text-sm.opacity-70');
    for (var i = 0; i < candidates.length; i++) {
      var t = candidates[i].innerText || '';
      if (t.indexOf('你的战利品') !== -1) {
        descEl = candidates[i];
        break;
      }
    }
    if (!descEl) return null;

    var parent = descEl.parentElement;
    if (!parent) return null;

    var itemEls = parent.querySelectorAll('div.flex.flex-col.items-center.gap-1');
    var names = [];
    for (var j = 0; j < itemEls.length; j++) {
      var el = itemEls[j];
      var name = '';
      var qty = 1;
      var spans = el.querySelectorAll('span');
      for (var k = 0; k < spans.length; k++) {
        var s = spans[k];
        var cls = String(s.className || '');
        var st = (s.textContent || '').trim();
        if (cls.indexOf('absolute') !== -1 && cls.indexOf('bottom-0') !== -1) {
          var n = parseInt(st, 10);
          if (!isNaN(n)) qty = n;
        } else if (cls.indexOf('opacity-60') !== -1 || cls.indexOf('truncate') !== -1) {
          if (st) name = st;
        }
      }
      if (name) names.push(qty > 1 ? name + ' ×' + qty : name);
    }

    var desc = (descEl.innerText || '').trim();
    return {
      desc: desc,
      loot: names.join('、'),
      signature: desc + '|' + names.join('|')
    };
  }

  function handleBossLoot() {
    if (!running) return false;

    var info = getBossLoot();
    if (!info) return false;
    if (info.signature === lastBossLootSignature) return false;

    lastBossLootSignature = info.signature;
    lastBossLootTime = nowTimeString();
    lastBossLootContent = info.loot || '无物品掉落';
    updateBossLoot();

    console.log(PREFIX + ' 🏆 检测到首领战利品: ' + lastBossLootContent);
    return true;
  }

  // ============ 统一监控 ============
  function tick() {
    if (!running) return;
    handleRewardPopup();
    handleBossAttack();
    handleLevelUpPopup();
    handleBossLoot();
    updateBossLoot();
  }

  function startMonitors() {
    if (observer) return;
    observer = new MutationObserver(function () {
      tick();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    pollTimer = setInterval(tick, 2000);
    console.log(PREFIX + ' 监控已启动');
  }

  function stopMonitors() {
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ============ 悬浮窗 ============
  function initState() {
    try {
      running = localStorage.getItem(STORAGE_KEY) === '1';
    } catch (e) {
      running = false;
    }
    try {
      minimized = localStorage.getItem(MIN_KEY) === '1';
    } catch (e) {
      minimized = false;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, running ? '1' : '0');
      localStorage.setItem(MIN_KEY, minimized ? '1' : '0');
    } catch (e) {}
  }

  function updateLastReward() {
    var timeEl = document.getElementById('ps-last-time');
    var contentEl = document.getElementById('ps-last-content');
    if (timeEl) timeEl.textContent = lastRewardTime || '暂无';
    if (contentEl) contentEl.textContent = lastRewardContent || '尚未领取任何奖励';
  }

  function updateBossLoot() {
    var timeEl = document.getElementById('ps-boss-loot-time');
    var contentEl = document.getElementById('ps-boss-loot-content');
    if (isBossAttacking()) {
      if (timeEl) timeEl.textContent = '进行中';
      if (contentEl) contentEl.textContent = '正在攻击首领';
    } else {
      if (timeEl) timeEl.textContent = lastBossLootTime || '暂无';
      if (contentEl) contentEl.textContent = lastBossLootContent || '尚未击败首领';
    }
  }

  function updatePanel() {
    var panel = document.getElementById('ps-auto-panel');
    if (panel) {
      if (running) {
        panel.classList.add('ps-running');
      } else {
        panel.classList.remove('ps-running');
      }
    }
    var toggle = document.getElementById('ps-toggle');
    if (toggle) toggle.textContent = running ? '停止' : '启动';
    updateLastReward();
    updateBossLoot();
    applyMinimized();
  }

  function applyMinimized() {
    var body = document.getElementById('ps-body');
    var minBtn = document.getElementById('ps-min-btn');
    if (body) body.style.display = minimized ? 'none' : 'block';
    if (minBtn) minBtn.textContent = minimized ? '+' : '–';
  }

  function buildPanel() {
    var style = document.createElement('style');
    style.textContent = [
      '#ps-auto-panel{position:fixed!important;right:16px!important;bottom:16px!important;z-index:2147483647!important;width:210px;border-radius:10px;overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,.5);border:1px solid rgba(201,162,75,.35);background:rgba(24,18,10,.94);color:#e8e0d0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.4;}',
      '#ps-auto-panel .ps-header{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(201,162,75,.14);cursor:pointer;user-select:none;}',
      '#ps-auto-panel .ps-title{font-weight:600;color:#e8c97a;flex:1;font-size:12px;}',
      '#ps-auto-panel .ps-min-btn{width:22px;height:22px;line-height:20px;text-align:center;border:1px solid rgba(232,201,122,.35);border-radius:5px;background:transparent;color:#e8c97a;cursor:pointer;font-size:14px;padding:0;}',
      '#ps-auto-panel .ps-body{padding:10px;}',
      '#ps-auto-panel .ps-last{margin-bottom:8px;font-size:12px;}',
      '#ps-auto-panel .ps-boss-loot{margin-bottom:8px;font-size:12px;padding-top:6px;border-top:1px solid rgba(201,162,75,.2);}',
      '#ps-auto-panel .ps-last-label{color:#8a8070;font-size:11px;margin-bottom:4px;}',
      '#ps-auto-panel .ps-last-time{color:#e8c97a;font-weight:600;margin-bottom:2px;}',
      '#ps-auto-panel .ps-last-content{color:#e8e0d0;word-break:break-all;}',
      '#ps-auto-panel .ps-toggle{width:100%;padding:8px 0;border-radius:7px;border:1px solid transparent;cursor:pointer;font-size:13px;font-weight:600;background:rgba(201,162,75,.9);color:#1a140e;}',
      '#ps-auto-panel.ps-running .ps-toggle{background:rgba(120,80,60,.9);color:#f3e9d2;}'
    ].join('\n');
    document.head.appendChild(style);

    var panel = document.createElement('div');
    panel.id = 'ps-auto-panel';
    panel.innerHTML = [
      '<div class="ps-header" id="ps-header">',
      '  <span class="ps-title">Partyscape 自动脚本</span>',
      '  <button class="ps-min-btn" id="ps-min-btn" title="最小化">–</button>',
      '</div>',
      '<div class="ps-body" id="ps-body">',
      '  <div class="ps-last">',
      '    <div class="ps-last-label">最近领取</div>',
      '    <div class="ps-last-time" id="ps-last-time">暂无</div>',
      '    <div class="ps-last-content" id="ps-last-content">尚未领取任何奖励</div>',
      '  </div>',
      '  <div class="ps-boss-loot">',
      '    <div class="ps-last-label">首领战利品</div>',
      '    <div class="ps-last-time" id="ps-boss-loot-time">暂无</div>',
      '    <div class="ps-last-content" id="ps-boss-loot-content">尚未击败首领</div>',
      '  </div>',
      '  <button class="ps-toggle" id="ps-toggle">启动</button>',
      '</div>'
    ].join('\n');
    document.body.appendChild(panel);

    document.getElementById('ps-toggle').addEventListener('click', function () {
      setRunning(!running);
    });
    document.getElementById('ps-header').addEventListener('click', function () {
      minimized = !minimized;
      saveState();
      applyMinimized();
    });

    updatePanel();
  }

  // ============ 启停控制 ============
  function start() {
    loginAbort = false;
    startMonitors();
    autoLogin();
    console.log(PREFIX + ' 已启动');
  }

  function stop() {
    loginAbort = true;
    stopMonitors();
    console.log(PREFIX + ' 已停止');
  }

  function setRunning(val) {
    if (running === val) return;
    running = val;
    saveState();
    updatePanel();
    if (running) {
      start();
    } else {
      stop();
    }
  }

  // ============ 启动 ============
  function main() {
    initState();
    buildPanel();
    if (running) {
      start();
    } else {
      stop();
    }
    console.log(PREFIX + ' 脚本已加载，当前状态: ' + (running ? '运行中' : '已停止'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();

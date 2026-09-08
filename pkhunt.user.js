// ==UserScript==
// @name         PKHunt 伤药/开箱 自动脚本
// @namespace    pkhunt-potion-auto
// @version      1.7.2
// @description  监控所选等级伤药数量, 低于阈值自动采购; 自动通过API开启宝箱; 悬浮窗分状态/设置两页; 睡眠模式弹窗自动返回游戏并推送微信; 团队战自动创建-选最高级-配置自动开始; 幸运机免费代币-转动-开胶囊-微信推送
// @author       Old Lee
// @match        https://pkhunt.online/*
// @updateURL    https://raw.githubusercontent.com/simbary/scripts/main/pkhunt.user.js
// @downloadURL  https://raw.githubusercontent.com/simbary/scripts/main/pkhunt.user.js
// @supportURL   https://github.com/simbary/scripts
// @grant        GM_xmlhttpRequest
// @connect      qyapi.weixin.qq.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ---------- 配置 ----------
  const CONFIG = {
    minCount: 30,               // 低于此数量触发采购
    buyQty: 20,                 // 每次采购数量
    checkIntervalMs: 15000,     // 监控间隔(毫秒)

    // 可选伤药类型
    POTIONS: [
      { id: "90020", label: "伤药",       pct: "30%"  },
      { id: "90021", label: "好伤药",     pct: "50%"  },
      { id: "90022", label: "高级伤药",   pct: "80%"  },
      { id: "90023", label: "满恢复",     pct: "100%" }
    ],

    actionBuyId: "7880672fa09bba3b9560e822e073c2854321a9a702", // 采购Server Action
    actionChestId: "78dfd1e727ee8325614bc78f8dca11a2293fb10189", // 开宝箱Server Action
    actionGiftId: "" // 每日礼包领取Server Action (待填充)
  };

  const defaultPotion = CONFIG.POTIONS[0];

  // 微信消息推送
  const WX_KEY_STORAGE = "pkh_wx_key_v1";

  // ---------- 状态 ----------
  const STORAGE_KEY = "pkh_potion_state_v1";

  // 从本地存储恢复开关状态 (默认关闭)
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return { enabled: typeof s.enabled === "boolean" ? s.enabled : false, wxKey: typeof s.wxKey === "string" ? s.wxKey : "" };
      }
    } catch (e) {}
    return { enabled: false, wxKey: "" };
  }
  const persisted = loadState();

  const state = {
    enabled: persisted.enabled,
    minimized: false,
    page: "status",
    expanded: true,
    selected: CONFIG.POTIONS[persisted.selIndex && persisted.selIndex < CONFIG.POTIONS.length ? persisted.selIndex : 0] || defaultPotion,
    selIndex: persisted.selIndex || 0,
    lastCount: null,
    buying: false,
    lastBuyAt: 0,
    opening: false,
    wxKey: persisted.wxKey || "",
    dailyGiftClaimedToday: false,
    claimDailyGiftAt: 0,
    lastSleepPopupHandledAt: 0,
    raidActive: false,       // 团队战流程执行中标记
    raidLastRunAt: 0,        // 上次尝试团队战的时间
    raidStarted: false,      // 本次循环是否已点击开始
    raidWaitSince: 0,        // 进入组队等待的时间戳
    luckySpinActive: false,  // 幸运机流程执行中标记
    luckySpinAt: 0,         // 上次幸运机时间
    luckyDoneToday: false,  // 今天已完成幸运机
    luckyDoneAt: 0,         // 今天完成的时间戳
    invNextRunAt: 0,        // 下次背包整理时间戳
    invRunning: false,      // 背包整理流程执行中
    invStep: 0              // 整理步骤标记
  };

  // 保存开关状态到本地存储
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        enabled: state.enabled,
        selIndex: state.selIndex,
        wxKey: state.wxKey
      }));
    } catch (e) {}
  }

  // ---------- 悬浮窗样式 ----------
  const STYLE = `
  #pkh-panel {
    position: fixed; left: 16px; top: 16px; z-index: 2147483646;
    font-family: "Segoe UI", Arial, sans-serif; user-select: none;
    color: #e8ecf3; background: rgba(10, 14, 20, 0.96);
    border: 1px solid rgba(96, 165, 250, 0.4); border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.5); overflow: hidden;
    width: 240px;
  }
  #pkh-panel .pkh-head {
    display: flex; align-items: center; gap: 6px; padding: 8px 10px;
    background: rgba(96, 165, 250, 0.12); cursor: pointer; font-weight: 700; font-size: 13px;
  }
  #pkh-panel .pkh-title { flex: 1; }
  #pkh-panel .pkh-btn {
    border: none; background: transparent; color: #9fb3c8; cursor: pointer;
    font-size: 16px; line-height: 1; padding: 3px 7px; border-radius: 4px;
    min-width: 24px; text-align: center;
  }
  #pkh-panel .pkh-btn:hover { background: rgba(255,255,255,0.15); color: #fff; }
  #pkh-panel .pkh-tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.1); }
  #pkh-panel .pkh-tab { flex: 1; padding: 6px 0; text-align: center; font-size: 12px; color: #7d8ea1; cursor: pointer; border-bottom: 2px solid transparent; }
  #pkh-panel .pkh-tab.active { color: #fff; border-bottom-color: #317bee; }
  #pkh-panel .pkh-page { padding: 10px; display: none; flex-direction: column; gap: 8px; }
  #pkh-panel .pkh-page.active { display: flex; }
  #pkh-panel .pkh-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
  #pkh-panel .pkh-val { font-family: monospace; font-weight: 700; font-size: 15px; color: #ffe68a; }
  #pkh-panel .pkh-hint { font-size: 11px; color: #7d8ea1; line-height: 1.3; }
  #pkh-panel .pkh-field { font-size: 12px; }
  #pkh-panel .pkh-field label { display: block; margin-bottom: 4px; color: #9fb3c8; }
  #pkh-panel .pkh-field select { width: 100%; padding: 5px 6px; color: #e8ecf3; background: #151d2b; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; font-size: 12px; }
  #pkh-panel .pkh-collapse-wrap { border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; overflow: hidden; }
  #pkh-panel .pkh-collapse-head { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px; background: rgba(255,255,255,0.05); cursor: pointer; font-size: 12px; font-weight: 700; }
  #pkh-panel .pkh-collapse-head .pkh-arrow { transition: transform 0.2s; color: #7d8ea1; }
  #pkh-panel .pkh-collapse-wrap.open .pkh-arrow { transform: rotate(90deg); }
  #pkh-panel .pkh-collapse-body { display: none; padding: 9px; }
  #pkh-panel .pkh-collapse-wrap.open .pkh-collapse-body { display: block; }
  #pkh-switch { position: relative; width: 34px; height: 18px; flex-shrink: 0; }
  #pkh-switch input { opacity: 0; width: 0; height: 0; }
  #pkh-switch .pkh-slider { position: absolute; cursor: pointer; inset: 0; background: #3a4552; border-radius: 18px; transition: 0.2s; }
  #pkh-switch .pkh-slider:before { content: ""; position: absolute; height: 12px; width: 12px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
  #pkh-panel input:checked + .pkh-slider { background: #317bee; }
  #pkh-panel input:checked + .pkh-slider:before { transform: translateX(16px); }
  #pkh-panel.minimized .pkh-tabs, #pkh-panel.minimized .pkh-page { display: none; }
  #pkh-panel.off .pkh-tabs, #pkh-panel.off .pkh-page { display: none; }
`;

  // ---------- 建立悬浮窗 ----------
  function buildPanel() {
    const styleEl = document.createElement("style");
    styleEl.textContent = STYLE;
    document.head.appendChild(styleEl);

    const panel = document.createElement("div");
    panel.id = "pkh-panel";
    panel.style.position = "fixed";
    panel.style.left = "16px";
    panel.style.top = "16px";
    panel.style.zIndex = "2147483646";
    if (state.minimized) panel.classList.add("minimized");
    if (!state.enabled) panel.classList.add("off");

    const head = document.createElement("div");
    head.className = "pkh-head";
    head.title = "点击最小化/展开";

    const title = document.createElement("span");
    title.className = "pkh-title";
    title.textContent = "POKEHUNT助手";

    const switchLabel = document.createElement("label");
    switchLabel.id = "pkh-switch";
    switchLabel.title = "功能总开关";
    const switchInput = document.createElement("input");
    switchInput.type = "checkbox";
    switchInput.checked = state.enabled;
    switchInput.addEventListener("change", (e) => {
      state.enabled = e.target.checked;
      panel.classList.toggle("off", !state.enabled);
      appendLog(state.enabled ? "监控已开启" : "监控已关闭");
      saveState();
      if (state.enabled) checkAndBuy();
    });
    const slider = document.createElement("span");
    slider.className = "pkh-slider";
    switchLabel.appendChild(switchInput);
    switchLabel.appendChild(slider);

    head.addEventListener("click", () => {
      state.minimized = panel.classList.toggle("minimized");
    });

    head.appendChild(title);
    head.appendChild(switchLabel);

    // 页签
    const tabs = document.createElement("div");
    tabs.className = "pkh-tabs";
    const tabStatus = document.createElement("div");
    tabStatus.className = "pkh-tab active";
    tabStatus.textContent = "状态";
    const tabSettings = document.createElement("div");
    tabSettings.className = "pkh-tab";
    tabSettings.textContent = "设置";
    tabStatus.addEventListener("click", () => showPage("status"));
    tabSettings.addEventListener("click", () => showPage("settings"));
    tabs.appendChild(tabStatus);
    tabs.appendChild(tabSettings);

    // ---------- 状态页 ----------
    const pageStatus = document.createElement("div");
    pageStatus.className = "pkh-page active";
    pageStatus.id = "pkh-page-status";

    const stRow = document.createElement("div");
    stRow.className = "pkh-row";
    stRow.innerHTML = `<span>监控伤药类型</span><span class="pkh-val" style="font-size:12px;" id="pkh-stype">${state.selected.label}</span>`;
    const cntRow = document.createElement("div");
    cntRow.className = "pkh-row";
    cntRow.innerHTML = `<span>当前数量</span><span class="pkh-val" id="pkh-count">--</span>`;
    const chestRow = document.createElement("div");
    chestRow.className = "pkh-row";
    chestRow.innerHTML = `<span>待开宝箱</span><span class="pkh-val" style="font-size:12px;" id="pkh-chest">--</span>`;
    const hint = document.createElement("div");
    hint.className = "pkh-hint";
    hint.id = "pkh-hint";
    hint.textContent = `自动采购 ${state.selected.label}`;
    pageStatus.appendChild(stRow);
    pageStatus.appendChild(cntRow);
    pageStatus.appendChild(chestRow);
    const invRow = document.createElement("div");
    invRow.className = "pkh-row";
    invRow.innerHTML = `<span>下次背包整理</span><span class="pkh-val" style="font-size:12px;" id="pkh-invtime">--</span>`;
    pageStatus.appendChild(invRow);
    pageStatus.appendChild(hint);

    // ---------- 设置页 ----------
    const pageSettings = document.createElement("div");
    pageSettings.className = "pkh-page";
    pageSettings.id = "pkh-page-settings";

    const collapse = document.createElement("div");
    collapse.className = "pkh-collapse-wrap";
    const collapseHead = document.createElement("div");
    collapseHead.className = "pkh-collapse-head";
    collapseHead.innerHTML = `<span>自动购买伤药</span><span class="pkh-arrow">▸</span>`;
    collapseHead.addEventListener("click", () => {
      state.expanded = collapse.classList.toggle("open");
    });
    const collapseBody = document.createElement("div");
    collapseBody.className = "pkh-collapse-body";

    const field = document.createElement("div");
    field.className = "pkh-field";
    const lab = document.createElement("label");
    lab.textContent = "购买伤药类型";
    const select = document.createElement("select");
    select.id = "pkh-potion-select";
    CONFIG.POTIONS.forEach((p, i) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label + " (治疗 " + p.pct + ")";
      if (i === state.selIndex) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", (e) => {
      const idx = CONFIG.POTIONS.findIndex(x => x.id === e.target.value);
      if (idx < 0) return;
      state.selected = CONFIG.POTIONS[idx];
      state.selIndex = idx;
      updateStatusUI();
      appendLog("切换采购类型为 " + state.selected.label);
    });
    field.appendChild(lab);
    field.appendChild(select);

    // 采购阈值 (移动到设置分栏内)
    const threshold = document.createElement("div");
    threshold.className = "pkh-row";
    threshold.style.marginTop = "8px";
    threshold.innerHTML = `<span>采购阈值</span><span class="pkh-val" style="font-size:12px;">&lt; ${CONFIG.minCount} → 买 ${CONFIG.buyQty}</span>`;

    collapseBody.appendChild(field);
    collapseBody.appendChild(threshold);
    collapse.appendChild(collapseHead);
    collapse.appendChild(collapseBody);
    pageSettings.appendChild(collapse);

    // 微信消息推送设置
    const wxCollapse = document.createElement("div");
    wxCollapse.className = "pkh-collapse-wrap";
    const wxCollapseHead = document.createElement("div");
    wxCollapseHead.className = "pkh-collapse-head";
    wxCollapseHead.innerHTML = `<span>微信消息推送设置</span><span class="pkh-arrow">▸</span>`;
    wxCollapseHead.addEventListener("click", () => {
      wxCollapse.classList.toggle("open");
    });
    const wxCollapseBody = document.createElement("div");
    wxCollapseBody.className = "pkh-collapse-body";

    const wxField = document.createElement("div");
    wxField.className = "pkh-field";
    const wxLab = document.createElement("label");
    wxLab.textContent = "微信机器人 Key";
    const wxInput = document.createElement("input");
    wxInput.type = "password";
    wxInput.id = "pkh-wx-key-input";
    wxInput.placeholder = "请输入微信机器人 key";
    wxInput.value = state.wxKey;
    wxInput.addEventListener("change", (e) => {
      state.wxKey = e.target.value.trim();
      saveState();
      appendLog("微信机器人 Key 已保存");
    });
    wxField.appendChild(wxLab);
    wxField.appendChild(wxInput);

    const wxHint = document.createElement("div");
    wxHint.className = "pkh-hint";
    wxHint.style.marginTop = "8px";
    wxHint.textContent = "填入企业微信机器人 Webhook Key，保存后用于消息推送。";
    wxCollapseBody.appendChild(wxField);
    wxCollapseBody.appendChild(wxHint);
    wxCollapse.appendChild(wxCollapseHead);
    wxCollapse.appendChild(wxCollapseBody);
    pageSettings.appendChild(wxCollapse);

    panel.appendChild(head);
    panel.appendChild(tabs);
    panel.appendChild(pageStatus);
    panel.appendChild(pageSettings);
    document.body.appendChild(panel);

    window.__pkhState = {
      countEl: document.getElementById("pkh-count"),
      stypeEl: document.getElementById("pkh-stype"),
      chestEl: document.getElementById("pkh-chest"),
      hintEl: document.getElementById("pkh-hint"),
      tabStatus: tabStatus,
      tabSettings: tabSettings,
      pageStatus: pageStatus,
      pageSettings: pageSettings
    };
  }

  function showPage(page) {
    state.page = page;
    const s = window.__pkhState;
    const isStatus = page === "status";
    s.tabStatus.classList.toggle("active", isStatus);
    s.tabSettings.classList.toggle("active", !isStatus);
    s.pageStatus.classList.toggle("active", isStatus);
    s.pageSettings.classList.toggle("active", !isStatus);
  }

  function updateStatusUI() {
    const s = window.__pkhState;
    if (!s) return;
    s.stypeEl.textContent = state.selected.label;
    s.hintEl.textContent = "自动采购 " + state.selected.label + " (治疗 " + state.selected.pct + ")";
    const c = state.lastCount;
    s.countEl.textContent = (c === null || c === undefined) ? "--" : String(c);
  }

  function appendLog(msg) {
    try {
      return; // 日志框已移除
      const d = document.createElement("div");
      const t = new Date();
      const ts = t.getHours().toString().padStart(2,"0") + ":" + t.getMinutes().toString().padStart(2,"0") + ":" + t.getSeconds().toString().padStart(2,"0");
      d.textContent = "[" + ts + "] " + msg;
      el.appendChild(d);
      // 只保留最近6条
      while (el.children.length > 6) el.removeChild(el.firstChild);
    } catch (e) {}
  }

  function updateCountUI(count) {
    state.lastCount = count;
    if (window.__pkhState && window.__pkhState.countEl) {
      window.__pkhState.countEl.textContent = (count === null || count === undefined) ? "--" : String(count);
    }
  }

  function updateChestUI(n) {
    if (window.__pkhState && window.__pkhState.chestEl) {
      window.__pkhState.chestEl.textContent = (n === null || n === undefined) ? "--" : String(n);
    }
  }

  function updateInvTimeUI() {
    const el = document.getElementById("pkh-invtime");
    if (!el) return;
    if (!state.invNextRunAt) { el.textContent = "--"; return; }
    const t = new Date(state.invNextRunAt);
    const hh = t.getHours().toString().padStart(2, "0");
    const mm = t.getMinutes().toString().padStart(2, "0");
    el.textContent = hh + ":" + mm;
  }

  // ---------- API: fetch游戏状态 ----------
  async function fetchState() {
    const body = JSON.stringify([
      { "balls": [], "potions": [ { "itemId": state.selected.id, "qty": 0 } ], "revives": [] },
      "00000000-0000-0000-0000-000000000000",
      false,
      0
    ]);
    const res = await fetch("/en/play", {
      method: "POST",
      headers: {
        "Accept": "text/x-component",
        "Content-Type": "text/x-component",
        "Next-Action": CONFIG.actionBuyId
      },
      body: body
    });
    return await res.text();
  }

  // 从状态文本中提取背包里某商品的数目
  function countInBackpack(text, itemId) {
    const re = new RegExp('"backpack"\\s*:\\s*\\{[^}]*?"' + itemId + '"\\s*:\\s*(\\d+)', "s");
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : null;
  }

  // 生成仿真实UI的随机nonce
  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return ("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx").replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // 从状态文本中解析宝箱数组
  function parseChests(text) {
    const m = text.match(/"chests"\s*:\s*(\[.*?\])/s);
    if (!m) return [];
    try {
      const arr = JSON.parse(m[1]);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  // ---------- 采购所选伤药 ----------
  async function buyPotions(qty) {
    const body = JSON.stringify([
      { "balls": [], "potions": [ { "itemId": state.selected.id, "qty": qty } ], "revives": [] },
      makeId(),
      true,
      51
    ]);
    const res = await fetch("/en/play", {
      method: "POST",
      headers: {
        "Accept": "text/x-component",
        "Content-Type": "text/x-component",
        "Next-Action": CONFIG.actionBuyId
      },
      body: body
    });
    const text = await res.text();
    return { status: res.status, newCount: countInBackpack(text, state.selected.id) };
  }

  // ---------- 开一个宝箱 ----------
  async function openChest(chestId) {
    const body = JSON.stringify([chestId, makeId(), true, 54]);
    const res = await fetch("/en/play", {
      method: "POST",
      headers: {
        "Accept": "text/x-component",
        "Content-Type": "text/x-component",
        "Next-Action": CONFIG.actionChestId
      },
      body: body
    });
    const text = await res.text();
    return { status: res.status, text: text };
  }

  // ---------- 每日礼包 API ----------
  // 依据 fishing_cast 每日登录奖励逻辑, 每日礼包通过 server action 领取,
  // 返回文本中可解析出奖励内容后推送微信
  async function claimDailyGift() {
    if (!CONFIG.actionGiftId) {
      appendLog("每日礼包: 未配置 actionGiftId, 跳过");
      return null;
    }
    const now = Date.now();
    if (now - state.claimDailyGiftAt < 60000) return null;
    state.claimDailyGiftAt = now;
    // 请求体参考现有 fetch: [payload, nonce, true, actionId]
    const body = JSON.stringify([
      {},
      makeId(),
      true,
      0
    ]);
    try {
      const res = await fetch("/en/play", {
        method: "POST",
        headers: {
          "Accept": "text/x-component",
          "Content-Type": "text/x-component",
          "Next-Action": CONFIG.actionGiftId
        },
        body: body
      });
      const text = await res.text();
      if (res.status !== 200) {
        appendLog("每日礼包请求失败 HTTP " + res.status);
        return null;
      }
      state.dailyGiftClaimedToday = true;
      appendLog("每日礼包领取请求成功");
      return { status: res.status, text: text };
    } catch (e) {
      appendLog("每日礼包请求异常: " + e.message);
      return null;
    }
  }

  // 从返回文本中解析奖励内容并拼接采购/礼包信息
  function parseRewardText(text) {
    if (!text) return "";
    const lines = [];
    try {
      // 常见响应: 奖励数组 / items / rewards
      const m = text.match(/\"(reward|rewards|items|gift|gifts|content|contents)\"\s*:\s*(\[.*?\]|\{.*?\})/s);
      if (m) {
        const val = m[2];
        lines.push(val);
      }
    } catch (e) {}
    if (lines.length === 0) {
      // 无关键词时尽量截取一段可读文本
      const t = text.replace(/\s+/g, " ").slice(0, 300);
      lines.push(t);
    }
    return lines.join(" ");
  }

  // ---------- 微信消息推送 ----------
  // 参考 fishing_cast 脚本: 通过企业微信机器人 Webhook 推送
  function sendWxBot(botKey, msg) {
    if (!botKey) return;
    const url = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + botKey;
    const payload = {
      msgtype: "markdown_v2",
      markdown_v2: { content: msg }
    };
    try {
      GM_xmlhttpRequest({
        method: "POST",
        url: url,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(payload),
        timeout: 10000,
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText);
            if (data.errcode === 0) {
              appendLog("微信消息推送成功");
            } else {
              appendLog("微信消息推送失败: " + (data.errcode || ""));
            }
          } catch (e) {
            appendLog("微信响应解析失败");
          }
        },
        onerror: (err) => { appendLog("微信推送异常"); },
        ontimeout: () => { appendLog("微信推送超时"); }
      });
    } catch (e) {
      // 降级使用 fetch (可能需要 CORS 支持)
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(() => { appendLog("微信推送降级失败"); });
    }
  }

  // 使用当前已保存的 Key 推送通知
  function sendWxNotification(msg) {
    if (!state.wxKey) return;
    const machineName = "PKHunt";
    const content = "【" + machineName + "】 " + msg;
    sendWxBot(state.wxKey, content);
  }

  // ---------- 睡眠模式弹窗监控 ----------
  // 查找包含「睡眠模式」文本的弹窗容器, 并返回其中「返回游戏」按钮
  function findSleepPopupButton(root) {
    root = root || document;

    // 方案一: 直接找标题 #sleep-title, 向上找到弹窗容器
    const titleEl = root.getElementById("sleep-title")
      || root.querySelector('[id="sleep-title"]')
      || Array.from(root.querySelectorAll("div")).find(el =>
          (el.textContent || "").replace(/\s+/g, "") === "睡眠模式"
        );
    if (titleEl) {
      // 向上找到 fixed 定位的弹窗容器 (role=alertdialog 或 inline fixed)
      let container = titleEl.parentElement;
      while (container && container !== document.body && container !== document.documentElement) {
        const cs = window.getComputedStyle(container);
        if (cs.position === "fixed" || container.getAttribute("role") === "alertdialog" || container.getAttribute("role") === "dialog") {
          break;
        }
        container = container.parentElement;
      }
      if (container) {
        const buttons = container.querySelectorAll("button");
        for (const btn of buttons) {
          const btnText = (btn.textContent || "").replace(/\s+/g, " ").trim();
          if (btnText.includes("返回游戏")) {
            const btnRect = btn.getBoundingClientRect();
            if (btnRect.width > 0 && btnRect.height > 0) return btn;
          }
        }
      }
    }

    // 方案二: 遍历 role=alertdialog / role=dialog 容器 (兼容无 id 的情况)
    const containers = root.querySelectorAll(
      "[role='alertdialog'], [role='dialog'], div.fixed.inset-0, .fixed, .modal, [data-state='open']"
    );
    for (const container of containers) {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      const text = (container.textContent || "").replace(/\s+/g, " ").trim();
      if (text.includes("睡眠模式")) {
        const buttons = container.querySelectorAll("button");
        for (const btn of buttons) {
          const btnText = (btn.textContent || "").replace(/\s+/g, " ").trim();
          if (btnText.includes("返回游戏")) {
            const btnRect = btn.getBoundingClientRect();
            if (btnRect.width > 0 && btnRect.height > 0) return btn;
          }
        }
        return null;
      }
    }
    return null;
  }

  // 处理睡眠模式弹窗: 点击返回游戏并推送微信
  function handleSleepPopup() {
    const btn = findSleepPopupButton(document);
    if (!btn) return false;

    // 去重: 最近 30 秒内已处理过则不重复处理
    const now = Date.now();
    if (now - state.lastSleepPopupHandledAt < 30000) return false;
    state.lastSleepPopupHandledAt = now;

    btn.click();
    appendLog("检测到睡眠模式弹窗, 已点击返回游戏");
    sendWxNotification("😴 检测到睡眠模式弹窗，已自动点击返回游戏");
    return true;
  }

  // 启动睡眠弹窗 MutationObserver: 弹窗出现时立即响应
  function startSleepPopupWatcher() {
    if (window.__pkhSleepObserver) return;
    if (!document.body) return;
    const mo = new MutationObserver(() => {
      if (!state.enabled) return;
      handleSleepPopup();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    window.__pkhSleepObserver = mo;
  }

  // 备用轮询: 每 2 秒检查一次, 防止 MutationObserver 漏掉
  function startSleepPopupPolling() {
    if (window.__pkhSleepPollTimer) return;
    window.__pkhSleepPollTimer = setInterval(() => {
      if (!state.enabled) return;
      handleSleepPopup();
    }, 2000);
  }

  // ---------- 团队战自动执行 ----------
  // 打开团队战面板 (点击导航栏"团队战")
  // 判断团队战当前是否可触发
  function getRaidStatus() {
    if (raidResultOpen()) return true;
    if (isInRaidTeam()) return true;
    return raidCreateAvailable();
  }

  function clickRaidNav() {
    const navBtns = document.querySelectorAll("button");
    for (const b of navBtns) {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (t.indexOf("团队战") === 0 && b.getBoundingClientRect().width > 0) {
        b.click();
        return true;
      }
    }
    return false;
  }

  // 从宝可梦网格中选等级最高的
  function clickHighestLevelMon() {
    const grid = document.querySelector("[data-testid='raid-mon-grid']");
    if (!grid) return false;
    const items = grid.querySelectorAll("button");
    let best = null, bestLv = -1;
    items.forEach(function (b) {
      const t = b.textContent || "";
      const m = t.match(/Lv\s*(\d+)/i);
      if (m) {
        const lv = parseInt(m[1], 10);
        if (lv > bestLv) { bestLv = lv; best = b; }
      }
    });
    if (best) { best.click(); return true; }
    return false;
  }

  // 点击按钮 (文本包含匹配)
  function clickBtnContaining(text) {
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (t.indexOf(text) >= 0 && b.getBoundingClientRect().width > 0) {
        b.click();
        return true;
      }
    }
    return false;
  }

  // 勾选 "Start on its own" 复选框
  function checkStartOnOwn() {
    const labels = document.querySelectorAll("label");
    for (const lb of labels) {
      const t = (lb.textContent || "").replace(/\s+/g, " ").trim();
      if (t.indexOf("Start on its own") >= 0) {
        const cb = lb.querySelector("input[type=checkbox]");
        if (cb && !cb.checked) { cb.click(); }
        return true;
      }
    }
    // 兜底: 全局找复选框
    const checks = document.querySelectorAll("input[type=checkbox]");
    for (const cb of checks) {
      const label = cb.closest("label");
      const t = label ? (label.textContent || "").replace(/\s+/g, " ").trim() : "";
      if (t.indexOf("Start on its own") >= 0 && !cb.checked) { cb.click(); return true; }
    }
    return false;
  }

  // 判断当前是否已在队伍中 (团队战面板内)
  function isInRaidTeam() {
    const t = document.body.innerText;
    return t.indexOf("阵型") >= 0 || t.indexOf("等待为") >= 0 || t.indexOf("短员") >= 0;
  }

  // 判断团队战面板已打开且有"创建我的队伍"
  function raidCreateAvailable() {
    const t = document.body.innerText;
    return t.indexOf("创建我的队伍") >= 0;
  }

  // 判断结算面板(战斗结束) - 需要点击关闭
  function raidResultOpen() {
    const t = document.body.innerText;
    return t.indexOf("观看回放") >= 0 && t.indexOf("领取奖励") >= 0;
  }

  // 关闭结算面板
  function closeRaidResult() {
    if (!raidResultOpen()) return false;
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const cls = (b.className || "").toString();
      const t = (b.textContent || "").trim();
      if (cls.indexOf("ui-panel-close") >= 0 && t === "\u2715") { b.click(); return true; }
    }
    // 兆底关闭: 找到面板关闭按钮点击
    const allBtns = document.querySelectorAll("button");
    for (const b of allBtns) {
      const cls = (b.className || "").toString();
      if (cls.indexOf("ui-panel-close") >= 0 && b.getBoundingClientRect().width > 0) { b.click(); return true; }
    }
    return false;
  }

  // 检查是否出现"开始"按钮 (表明可强制开始)
  function raidCanStart() {
    const t = document.body.innerText;
    return t.indexOf("开始 (short-handed)") >= 0 || t.indexOf("开始") >= 0;
  }

  // 检测"首领已被击败"战斗结束弹窗, 点击 关闭/跳过
  function closeRaidBattleResult() {
    const t = document.body.innerText;
    if (t.indexOf("首领已被击败") < 0) return false;
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const bt = (b.textContent || "").trim();
      const cls = (b.className || "").toString();
      if (bt === "关闭" && cls.indexOf("ui-btn") >= 0 && b.getBoundingClientRect().width > 0) {
        b.click(); return true;
      }
    }
    for (const b of btns) {
      const bt = (b.textContent || "").trim();
      if (bt.indexOf("跳过") >= 0 && b.getBoundingClientRect().width > 0) { b.click(); return true; }
    }
    return false;
  }

  // 检测"观看回放/领取奖励"胜利结算面板
  function closeRaidVictoryPanel() {
    const t = document.body.innerText;
    if (t.indexOf("观看回放") < 0 || t.indexOf("领取奖励") < 0) return false;
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const bt = (b.textContent || "").trim();
      if (bt === "领取奖励" && b.getBoundingClientRect().width > 0) { b.click(); return "claimed"; }
    }
    for (const b of btns) {
      const cls = (b.className || "").toString();
      if (cls.indexOf("ui-panel-close") >= 0 && b.getBoundingClientRect().width > 0) { b.click(); return "closed"; }
    }
    return false;
  }

  // 读取战利品文本 (从胜利结算面板)
  function extractRaidLoot() {
    const t = document.body.innerText;
    const idx = t.indexOf("观看回放");
    if (idx >= 0) {
      const chunk = t.slice(idx, idx + 800);
      return chunk.replace(/\s+/g, " ").slice(0, 400);
    }
    // 关键词检索
    const keys = ["战利品", "金币", "宝箱", "碎片"];
    for (const k of keys) {
      const ki = t.indexOf(k);
      if (ki >= 0) return t.slice(ki, ki + 200).replace(/\s+/g, " ").slice(0, 300);
    }
    return "";
  }

  // 团队战主流程
  async function runRaid() {
    // 已有面板在场 (可能是别的玩家弄的或已打开) - 需要场景判断
    const body = document.body.innerText;
    
    // 0. 战斗结束弹窗 -> 点击 关闭/跳过
    if (closeRaidBattleResult()) {
      appendLog("关闭战斗结果弹窗");
      return;
    }
    
    // 0b. 胜利结算面板 -> 领取奖励并关闭
    if (closeRaidVictoryPanel()) {
      const loot = extractRaidLoot();
      if (loot) {
        appendLog("胜利结算获得: " + loot);
        sendWxNotification("团队战胜利, 获得: " + loot);
      }
      return;
    }
    
    // 1. 结算面板 -> 关闭
    if (raidResultOpen()) { closeRaidResult(); return; }
    
    // 2. 已加入队伍 -> 等待
    if (isInRaidTeam()) {
      appendLog("已在团队队伍中, 等待开始");
      // 如果已等待超过5分钟 (300s), 点击开始
      const now = Date.now();
      if (!state.raidWaitSince) state.raidWaitSince = now;
      if (now - state.raidWaitSince >= 300000) {
        appendLog("等待超时5分钟, 点击开始");
        clickBtnContaining("开始");
        state.raidWaitSince = 0;
        state.raidActive = false;
      }
      return;
    }

    // 3. 不在队伍, 检查是否可创建
    const raidTask = window.__pkhRaidLock;
    if (raidTask) return;  // 已有团队战流程在跑
    
    // 尝试打开团队战面板
    if (!raidCreateAvailable()) {
      if (!clickRaidNav()) return;
      setTimeout(function(){ runRaid(); }, 800);
      return;
    }
    
    state.raidActive = true;
    state.raidLastRunAt = Date.now();
    appendLog("团队战可用, 开始自动创建");
    
    if (!clickBtnContaining("创建我的队伍")) { appendLog("创建按钮未找到"); return; }
    appendLog("创建队伍");
    
    setTimeout(function(){ 
      // 选最高级宝可梦
      if (!clickHighestLevelMon()) { appendLog("未找到宝可梦"); return; }
      appendLog("选择最高等级宝可梦");
      
      setTimeout(function(){
        // 发送这只宝可梦
        if (!clickBtnContaining("发送这只宝可梦")) { appendLog("未找到发送按钮"); return; }
        appendLog("发送宝可梦");
        
        setTimeout(function(){
          // 点击配置
          if (!clickBtnContaining("配置")) { 
            // 若已直接进入队伍, 跳到等待
            if (!isInRaidTeam()) return;
          }
          appendLog("打开配置");
          
          setTimeout(function(){
            // 勾选 Start on its own
            checkStartOnOwn();
            appendLog("勾选自动开始");
            
            // 点击节省规则 (确认)
            clickBtnContaining("节省规则");
            appendLog("保存配置");
            
            // 记录等待开始时间
            state.raidWaitSince = Date.now();
            state.raidStarted = false;
          }, 500);
        }, 500);
      }, 500);
    }, 500);
  }

  // 启动团队战监控: 周期性检查
  function startRaidMonitor() {
    if (window.__pkhRaidTimer) return;
    window.__pkhRaidTimer = setInterval(function() {
      if (!state.enabled) return;
      if (!state.raidActive && getRaidStatus()) runRaid();
    }, 10000);
  }

  // ---------- \u5e78\u8fd0\u673a\u81ea\u52a8\u6d41\u7a0b ----------
  // \u68c0\u6d4b\u5e78\u8fd0\u673a\u662f\u5426\u53ef\u7528: \u5bfc\u822a\u6309\u94ae\u6587\u672c\u4ee5"\u5e78\u8fd0\u673a"\u5f00\u5934\u4e14\u5e26\u89d2\u6807\u6570\u5b57
  function isLuckyAvailable() {
    if (state.luckyDoneToday) {
      // \u5b8c\u6210\u540e\u4eca\u5929\u4e0d\u518d\u91cd\u590d (\u5929\u5237\u65b0)
      const now = new Date();
      const done = new Date(state.luckyDoneAt);
      if (now.getFullYear() === done.getFullYear() && now.getMonth() === done.getMonth() && now.getDate() === done.getDate()) {
        return false;
      }
    }
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const t = (b.textContent || "").trim();
      // \u6309\u94ae\u6587\u672c\u53ef\u80fd\u662f"\u5e78\u8fd0\u673a1" (\u5e26\u89d2\u6807)
      if (t.indexOf("\u5e78\u8fd0\u673a") === 0 && t.length > 3 && b.getBoundingClientRect().width > 0) {
        return true;
      }
    }
    return false;
  }

  // \u70b9\u51fb\u5e78\u8fd0\u673a\u5bfc\u822a\u6309\u94ae
  function clickLuckyNav() {
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const t = (b.textContent || "").trim();
      if (t.indexOf("\u5e78\u8fd0\u673a") === 0 && b.getBoundingClientRect().width > 0) { b.click(); return true; }
    }
    return false;
  }

  // \u5e78\u8fd0\u673a\u4e3b\u6d41\u7a0b
  async function runLucky() {
    if (!state.enabled || state.luckySpinActive) return;
    if (state.luckyDoneToday) {
      const now = new Date();
      const done = new Date(state.luckyDoneAt);
      if (now.getFullYear() === done.getFullYear() && now.getMonth() === done.getMonth() && now.getDate() === done.getDate()) {
        return;  // \u4eca\u5929\u5df2\u5b8c\u6210
      }
    }
    
    const body = document.body.innerText;
    
    // \u5e78\u8fd0\u673a\u9875\u9762\u5df2\u6253\u5f00\u7684\u5224\u65ad
    const luckyPanelOpen = body.indexOf("\u5e78\u8fd0\u673a") >= 0 && (body.indexOf("\u514d\u8d39") >= 0 || body.indexOf("\u8f6c\u52a8") >= 0 || body.indexOf("\u6253\u5f00\u5b83\u4eec") >= 0);
    
    // \u5982\u679c\u5e78\u8fd0\u673a\u672a\u6253\u5f00, \u70b9\u51fb\u5e78\u8fd0\u673a\u5bfc\u822a
    if (!luckyPanelOpen) {
      if (clickLuckyNav()) {
        setTimeout(function(){ runLucky(); }, 600);
        return;
      }
      return;  // \u5e78\u8fd0\u673a\u4e0d\u53ef\u7528\u6216\u672a\u627e\u5230
    }
    
    state.luckySpinActive = true;
    
    // \u7b2c1\u6b65: \u70b9\u51fb \u514d\u8d39 \u6bcf\u65e5\u4ee3\u5e01 (\u5982\u679c\u53ef\u7528)
    if (body.indexOf("\u514d\u8d39\u6bcf\u65e5\u4ee3\u5e01") >= 0) {
      clickBtnContaining("\u514d\u8d39\u6bcf\u65e5\u4ee3\u5e01");
      appendLog("\u5e78\u8fd0\u673a: \u9886\u53d6\u514d\u8d39\u4ee3\u5e01");
      setTimeout(function(){ runLucky(); }, 800);
      return;
    }
    
    // \u7b2c2\u6b65: \u70b9\u51fb \u8f6c\u52a8
    if (body.indexOf("\u8f6c\u52a8") >= 0 && body.indexOf("\u4ee3\u5e01") >= 0 && body.indexOf("\u6253\u5f00\u5b83\u4eec") < 0) {
      const btns = document.querySelectorAll("button");
      for (const b of btns) {
        const t = (b.textContent || "").replace(/\s+/g, " ").trim();
        if (t.indexOf("\u8f6c\u52a8") === 0 && b.getBoundingClientRect().width > 0) { b.click(); break; }
      }
      appendLog("\u5e78\u8fd0\u673a: \u70b9\u51fb\u8f6c\u52a8");
      setTimeout(function(){ runLucky(); }, 1500);
      return;
    }
    
    // \u7b2c3\u6b65: \u62bd\u5956\u5b8c\u6210\u540e\u51fa\u73b0\u80f6\u56ca \u5168\u90e8\u6253\u5f00
    if (body.indexOf("\u5168\u90e8\u6253\u5f00") >= 0) {
      clickBtnContaining("\u5168\u90e8\u6253\u5f00");
      appendLog("\u5e78\u8fd0\u673a: \u6253\u5f00\u80f6\u56ca");
      setTimeout(function(){ runLucky(); }, 800);
      return;
    }
    
    // \u7b2c4\u6b65: \u83b7\u5f97\u545c\u54c1\u9875 -> \u8bfb\u53d6\u5e76\u5fae\u4fe1\u63a8\u9001
    if (body.indexOf("\u4fdd\u7559\u5956\u52b1") >= 0) {
      // \u8bfb\u53d6\u5956\u54c1\u5185\u5bb9
      const rewardArea = body.slice(body.indexOf("\u4fdd\u7559\u5956\u52b1") - 300, body.indexOf("\u4fdd\u7559\u5956\u52b1") + 50);
      const reward = rewardArea.replace(/\s+/g, " ").trim();
      appendLog("\u5e78\u8fd0\u673a\u83b7\u5f97: " + reward);
      sendWxNotification("\u4e2d\u596f\uff01\u5e78\u8fd0\u673a\u83b7\u5f97:\n" + reward);
      
      // \u70b9\u51fb\u4fdd\u7559\u5956\u52b1
      clickBtnContaining("\u4fdd\u7559\u5956\u52b1");
      state.luckyDoneToday = true;
      state.luckyDoneAt = Date.now();
      state.luckySpinActive = false;
      appendLog("\u5e78\u8fd0\u673a\u5b8c\u6210, \u4eca\u5929\u4e0d\u518d\u91cd\u590d");
      
      // \u5f85\u673a: \u70b9\u51fb\u6218\u6597\u9875\u9762
      setTimeout(function(){ clickBtnExact("\u6218\u6597"); }, 800);
      return;
    }
    
    // \u5176\u4ed6\u60c5\u51b5: \u7b49\u5f85\u4e0b\u4e00\u8f6e
    setTimeout(function(){ state.luckySpinActive = false; }, 3000);
  }

  // \u70b9\u51fb\u6587\u672c\u7cbe\u786e\u5339\u914d\u7684\u6309\u94ae
  function clickBtnExact(text) {
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const t = (b.textContent || "").trim();
      if (t === text && b.getBoundingClientRect().width > 0) { b.click(); return true; }
    }
    return false;
  }

  // \u542f\u52a8\u5e78\u8fd0\u673a\u76d1\u63a7
  function startLuckyMonitor() {
    if (window.__pkhLuckyTimer) return;
    window.__pkhLuckyTimer = setInterval(function() {
      if (!state.enabled) return;
      if (state.luckySpinActive) return;
      if (isLuckyAvailable()) {
        runLucky();
      }
    }, 15000);
  }

  // ---------- 背包物品整理 ----------
  function scheduleNextInvRun() {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    const extra = Math.floor(Math.random() * 11) * 60000;
    state.invNextRunAt = d.getTime() + extra;
    state.invRunning = false;
    updateInvTimeUI();
  }

  function clickNavByPrefix(prefix) {
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const t = (b.textContent || "").trim();
      if (t.indexOf(prefix) === 0 && b.getBoundingClientRect().width > 0) { b.click(); return true; }
    }
    return false;
  }

  function isBagOpen() {
    return document.body.innerText.indexOf("全部移至仓库") >= 0;
  }

  function isItemDialogOpen() {
    return document.body.innerText.indexOf("移动到背包") >= 0;
  }

  function isBagEmpty() {
    return document.body.innerText.indexOf("背包空") >= 0;
  }

  function clickMoveAllToStorage() {
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (t.indexOf("全部移至仓库") >= 0 && b.getBoundingClientRect().width > 0) { b.click(); return true; }
    }
    return false;
  }

  // 此函数不再通过名称预判, 而是从弹窗读取"物品类型"(第二行 类型·稀有度)
  // 因此改为: 依次点开每个仓库物品, 读类型, 决定移动/留守。
  // slave函数: 返回当前打开的弹窗的物品类型 (弹窗第二行 形如"伤药 · 稀有")
  function getOpenItemType() {
    const t = document.body.innerText;
    const lines = t.split(String.fromCharCode(10)).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
    // 弹窗序列: [名称, ✕, 名称, 类型, ·稀有度, ...]
    // 找到 名称 在位置 i 和 i+2 重复的地方
    for (let i = 0; i + 3 < lines.length; i++) {
      if (lines[i] === lines[i + 2] && lines[i + 1] === "✕") {
        // 类型行 = lines[i+3]
        const typeLine = lines[i + 3] || "";
        if (typeLine && typeLine.length < 40) return typeLine.trim();
      }
    }
    // 仍无: 直接用闭合方式查找"· 稀有度"前的行
    for (let i = 0; i < lines.length - 1; i++) {
      if (/·|•/.test(lines[i]) && lines[i].length < 30) {
        const prev = lines[i - 1] || "";
        if (prev && prev.length < 30 && prev !== "✕") return prev;
      }
    }
    return "";
  }

  // 判断某类型是否应放背包 (精灵球 或 伤药)
  function isKeepInBag(typeName) {
    if (!typeName) return false;
    const n = typeName.trim();
    // 精灵球 或 伤药 类型才留背包
    return n === "精灵球" || n === "伤药" ||
           n.indexOf("精灵球") >= 0 || n.indexOf("伤药") >= 0;
  }

  function moveToBag() {
    const btns = document.querySelectorAll("button");
    for (const b of btns) {
      const t = (b.textContent || "").trim();
      if (t.indexOf("移动到背包") >= 0 && b.getBoundingClientRect().width > 0) { b.click(); return true; }
    }
    return false;
  }

  function closeVisiblePanel() {
    const btns = document.querySelectorAll("button.ui-panel-close");
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { b.click(); return true; }
    }
    return false;
  }

    function runInvOrg() {
    if (!state.enabled) return;
    const now = Date.now();
    if (!state.invNextRunAt) scheduleNextInvRun();
    if (now < state.invNextRunAt) return;
    if (state.invRunning) return;

    state.invRunning = true;
    try {
      if (isItemDialogOpen()) {
        const typeName = getOpenItemType();
        if (isKeepInBag(typeName)) {
          if (moveToBag()) {
            appendLog("移动回背包: " + (typeName || "?"));
            setTimeout(function(){ closeVisiblePanel(); setTimeout(runInvOrg, 400); }, 300);
            return;
          }
        }
        closeVisiblePanel();
        setTimeout(runInvOrg, 400);
        return;
      }

      if (!isBagOpen()) {
        if (!clickNavByPrefix("背包")) { scheduleNextInvRun(); return; }
        setTimeout(runInvOrg, 500);
        return;
      }

      if (!isBagEmpty()) {
        if (clickMoveAllToStorage()) {
          setTimeout(runInvOrg, 600);
        } else {
          setTimeout(runInvOrg, 300);
        }
        return;
      }

      const slot = document.querySelector(".inv-slot");
      if (slot) {
        slot.click();
        setTimeout(runInvOrg, 500);
        return;
      }

      appendLog("背包整理完成");
      clickNavByPrefix("世界");
      scheduleNextInvRun();
    } catch (e) {
      appendLog("背包整理异常: " + e.message);
      scheduleNextInvRun();
    }
  }


  // ---------- 主逻辑 ----------
  async function checkAndBuy() {
    if (!state.enabled || state.buying) return;

    // 检测睡眠模式弹窗并处理
    handleSleepPopup();


    let text;
    try {
      text = await fetchState();
    } catch (e) {
      appendLog("读取状态失败: " + e.message);
      return;
    }

    // 伤药采购
    const count = countInBackpack(text, state.selected.id);
    if (count === null) {
      appendLog("未读到伤药数量");
    } else {
      updateCountUI(count);
      if (count < CONFIG.minCount) {
        const now = Date.now();
        if (now - state.lastBuyAt < 15000) return;
        state.lastBuyAt = now;
        state.buying = true;
        appendLog(state.selected.label + " " + count + " < " + CONFIG.minCount + ", 采购 " + CONFIG.buyQty);
        try {
          const r = await buyPotions(CONFIG.buyQty);
          if (r.status === 200) {
            if (r.newCount !== null) {
              updateCountUI(r.newCount);
              appendLog("采购成功, 当前 " + r.newCount);
            } else {
              appendLog("采购请求成功");
            }
          } else {
            appendLog("采购失败 HTTP " + r.status);
          }
        } catch (e) {
          appendLog("采购异常: " + e.message);
        } finally {
          state.buying = false;
        }
      }
    }

    // 自动开宝箱
    if (!state.opening) {
      const chests = parseChests(text);
      updateChestUI(chests.length);
      if (chests.length > 0) {
        state.opening = true;
        appendLog("发现宝箱 " + chests.length + " 个, 自动开启");
        try {
          const r = await openChest(chests[0].id);
          if (r.status === 200) {
            appendLog("开宝箱成功");
          } else {
            appendLog("开宝箱失败 HTTP " + r.status);
          }
        } catch (e) {
          appendLog("开宝箱异常: " + e.message);
        } finally {
          state.opening = false;
        }
      }
    }

    // 每日礼包领取
    if (!state.dailyGiftClaimedToday && CONFIG.actionGiftId) {
      appendLog("检测到可领取的每日礼包, 尝试领取");
      const giftRes = await claimDailyGift();
      if (giftRes) {
        const rewardText = parseRewardText(giftRes.text);
        const content = "✅ 已领取每日奖励" + (rewardText ? "，奖励内容：" + rewardText : "");
        appendLog(content);
        sendWxNotification(content);
      }
    }
  }

  // ---------- 启动 ----------
  let started = false;
  function start() {
    if (started) return;             // 防重复运行
    started = true;
    if (!document.body) {            // 等待 body 就绪
      setTimeout(start, 100);
      return;
    }
    buildPanel();
    window.__pkhReady = true;
    console.log("[PKHunt] 悬浮窗已创建");
    appendLog("脚本已启动");
    if (state.enabled) checkAndBuy();
    if (!window.__pkhTimer) {
      window.__pkhTimer = setInterval(checkAndBuy, CONFIG.checkIntervalMs);
    }
    startSleepPopupWatcher();
    startSleepPopupPolling();
    startRaidMonitor();
    startLuckyMonitor();
    scheduleNextInvRun();
    updateInvTimeUI();
    startInvMonitor();
  }

  if (document.readyState === "loading" || !document.body) {
    document.addEventListener("DOMContentLoaded", start);
    if (!document.body) setTimeout(start, 200);
  } else {
    start();
  }

  // ---------- 悬浮窗守卫 ----------
  // 游戏是SPA, 路由/React重渲染时可能清空document.body, 导致悬浮窗被移除。
  // 持续监听: 一旦#pkh-panel丢失就重建(且不中断已有逻辑)。
  function observePanel() {
    if (!document.body || window.__pkhPanelObserver) return;
    const mo = new MutationObserver(function () {
      if (window.__pkhSuppressGuard) return;
      if (!document.body) return;
      if (!document.getElementById("pkh-panel")) {
        // 面板被页面清掉 -> 直接用 buildPanel 重建 (不经过 start 的 started 防重)
        window.__pkhSuppressGuard = true;
        try { buildPanel(); } finally { window.__pkhSuppressGuard = false; }
      }
    });
    mo.observe(document.body, { childList: true, subtree: false });
    window.__pkhPanelObserver = mo;
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 100); return; }
    start();
    observePanel();
  }
  boot();
})();

// ==UserScript==
// @name         ArcaneAngler 自动登录监控
// @namespace    https://github.com/simbary/scripts
// @version      1.48
// @description  监控 ArcaneAngler 网页是否登出，自动重新登录，并通过企业微信机器人通知
// @author       simbary
// @match        https://arcaneangler.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      qyapi.weixin.qq.com
// @homepageURL  https://github.com/simbary/scripts
// @supportURL   https://github.com/simbary/scripts/issues
// @downloadURL  https://raw.githubusercontent.com/simbary/scripts/main/arcaneangler_monitor.user.js
// @updateURL    https://raw.githubusercontent.com/simbary/scripts/main/arcaneangler_monitor.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置存储 ====================
    const STORAGE_KEY = {
        BOT_KEY: 'aa_bot_key',
        MACHINE_NAME: 'aa_machine_name',
        USERNAME: 'aa_username',
        PASSWORD: 'aa_password',
        MONITOR_ENABLED: 'aa_monitor_enabled',
        FLOAT_MINIMIZED: 'aa_float_minimized',
        LOGOUT_NOTIFIED: 'aa_logout_notified',
        TOKEN_ALERT_RELOAD_AT: 'aa_token_alert_reload_at'
    };

    // ==================== 微信机器人 ====================
    function sendWxBot(botKey, msg) {
        if (!botKey) return;
        const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${botKey}`;
        const payload = {
            msgtype: "markdown_v2",
            markdown_v2: { content: msg }
        };

        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                timeout: 10000,
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.errcode === 0) {
                            console.log('✅ 微信消息推送成功');
                        } else {
                            console.error('❌ 微信消息推送失败:', data);
                        }
                    } catch (parseErr) {
                        console.error('❌ 微信响应解析失败:', res.responseText);
                    }
                },
                onerror: (err) => {
                    console.error('❌ 微信推送异常:', err);
                },
                ontimeout: () => {
                    console.error('❌ 微信推送超时');
                }
            });
        } catch (e) {
            // 降级使用 fetch（可能需要 CORS 支持）
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(err => {
                console.error('❌ 微信推送降级失败:', err);
            });
        }
    }

    function formatBotMessage(content) {
        const machineName = GM_getValue(STORAGE_KEY.MACHINE_NAME, '');
        const prefix = machineName ? `【${machineName}】` : '【ArcaneAngler】';
        return `${prefix} ${content}`;
    }

    // ==================== 悬浮窗 UI ====================
    function createFloatPanel() {
        const panel = document.createElement('div');
        panel.id = 'aa-monitor-panel';
        panel.innerHTML = `
            <div class="aa-panel-body">
                <div class="aa-header">
                    <span class="aa-title">ArcaneAngler 监控</span>
                    <button class="aa-min-btn" title="最小化">—</button>
                </div>
                <div class="aa-content">
                    <label class="aa-label">机器名</label>
                    <input type="text" id="aa-machine-name" class="aa-input" placeholder="如：服务器A" />
                    <label class="aa-label">微信机器人 Key</label>
                    <input type="text" id="aa-bot-key" class="aa-input" placeholder="请输入微信机器人 key" />
                    <label class="aa-label">登录账号</label>
                    <input type="text" id="aa-username" class="aa-input" placeholder="请输入登录账号" autocomplete="username" />
                    <label class="aa-label">登录密码</label>
                    <input type="password" id="aa-password" class="aa-input" placeholder="请输入登录密码" autocomplete="current-password" />
                    <div class="aa-actions">
                        <button id="aa-start-btn" class="aa-btn aa-btn-start">启动监控</button>
                        <button id="aa-stop-btn" class="aa-btn aa-btn-stop">关闭监控</button>
                    </div>
                    <div class="aa-status">
                        <span class="aa-status-left">
                            <span class="aa-dot" id="aa-status-dot"></span>
                            <span id="aa-status-text">未监控</span>
                        </span>
                        <span class="aa-status-right">
                            <span class="aa-dot" id="aa-boat-dot"></span>
                            <span id="aa-boat-text">未检测</span>
                        </span>
                    </div>
                    <div class="aa-biome-countdown" id="aa-biome-countdown">未检测</div>
                </div>
            </div>
            <button class="aa-restore-btn" title="展开">＋</button>
        `;
        document.body.appendChild(panel);
        return panel;
    }

    // ==================== 主逻辑 ====================
    let isMonitoring = false;
    let isLoggingIn = false;
    let retryAttempts = 0;
    const MAX_RETRY = 5;
    let boatDot = null;
    let boatText = null;
    let biomeCountdownEl = null;
    let biomeCountdownTimer = null;
    let nextBiomeTime = null;

    function setupUI(panel) {
        const body = panel.querySelector('.aa-panel-body');
        const restoreBtn = panel.querySelector('.aa-restore-btn');
        const minBtn = panel.querySelector('.aa-min-btn');
        const startBtn = panel.querySelector('#aa-start-btn');
        const stopBtn = panel.querySelector('#aa-stop-btn');
        const machineInput = panel.querySelector('#aa-machine-name');
        const botKeyInput = panel.querySelector('#aa-bot-key');
        const usernameInput = panel.querySelector('#aa-username');
        const passwordInput = panel.querySelector('#aa-password');
        const statusDot = panel.querySelector('#aa-status-dot');
        const statusText = panel.querySelector('#aa-status-text');
        // 注意：这里不能再次用 const 声明 boatDot/boatText，
        // 否则会遮蔽模块级变量，导致 setBoatStatus 里的赋值无效
        boatDot = panel.querySelector('#aa-boat-dot');
        boatText = panel.querySelector('#aa-boat-text');
        biomeCountdownEl = panel.querySelector('#aa-biome-countdown');

        // 加载已保存的配置
        machineInput.value = GM_getValue(STORAGE_KEY.MACHINE_NAME, '');
        botKeyInput.value = GM_getValue(STORAGE_KEY.BOT_KEY, '');
        usernameInput.value = GM_getValue(STORAGE_KEY.USERNAME, '');
        passwordInput.value = GM_getValue(STORAGE_KEY.PASSWORD, '');
        const savedEnabled = GM_getValue(STORAGE_KEY.MONITOR_ENABLED, false);
        const savedMinimized = GM_getValue(STORAGE_KEY.FLOAT_MINIMIZED, false);

        // 恢复最小化状态
        if (savedMinimized) {
            body.style.display = 'none';
            restoreBtn.style.display = 'block';
        }

        // 最小化按钮
        minBtn.addEventListener('click', () => {
            body.style.display = 'none';
            restoreBtn.style.display = 'block';
            GM_setValue(STORAGE_KEY.FLOAT_MINIMIZED, true);
        });

        // 恢复按钮
        restoreBtn.addEventListener('click', () => {
            body.style.display = 'block';
            restoreBtn.style.display = 'none';
            GM_setValue(STORAGE_KEY.FLOAT_MINIMIZED, false);
        });

        // 输入框内容变化时保存
        machineInput.addEventListener('change', () => {
            GM_setValue(STORAGE_KEY.MACHINE_NAME, machineInput.value.trim());
        });
        botKeyInput.addEventListener('change', () => {
            GM_setValue(STORAGE_KEY.BOT_KEY, botKeyInput.value.trim());
        });
        usernameInput.addEventListener('change', () => {
            GM_setValue(STORAGE_KEY.USERNAME, usernameInput.value.trim());
        });
        passwordInput.addEventListener('change', () => {
            GM_setValue(STORAGE_KEY.PASSWORD, passwordInput.value);
        });

        // 启动监控
        startBtn.addEventListener('click', () => {
            GM_setValue(STORAGE_KEY.MACHINE_NAME, machineInput.value.trim());
            GM_setValue(STORAGE_KEY.BOT_KEY, botKeyInput.value.trim());
            GM_setValue(STORAGE_KEY.USERNAME, usernameInput.value.trim());
            GM_setValue(STORAGE_KEY.PASSWORD, passwordInput.value);
            GM_setValue(STORAGE_KEY.MONITOR_ENABLED, true);
            isMonitoring = true;
            isLoggingIn = false;
            retryAttempts = 0;
            statusDot.classList.add('aa-dot-active');
            statusText.textContent = '监控中';
            startBtn.disabled = true;
            stopBtn.disabled = false;
            console.log('🎣 ArcaneAngler 监控已启动');
            // 从「即刻游玩」按钮开始检查
            startCheckFromPlay();
            // 同时启动轮询监控
            checkAndLogin();
        });

        // 关闭监控
        stopBtn.addEventListener('click', () => {
            GM_setValue(STORAGE_KEY.MONITOR_ENABLED, false);
            isMonitoring = false;
            isLoggingIn = false;
            retryAttempts = 0;
            statusDot.classList.remove('aa-dot-active');
            statusText.textContent = '未监控';
            startBtn.disabled = false;
            stopBtn.disabled = true;
            console.log('🛑 ArcaneAngler 监控已关闭');
        });

        // 恢复上次监控状态
        if (savedEnabled) {
            startBtn.click();
        }
    }

    function isLoggedOut() {
        // 查找"即刻游玩"按钮（仅可见的）
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.textContent.includes('即刻游玩')) {
                // 检查按钮是否可见（防止登录弹窗打开时误判）
                const rect = btn.getBoundingClientRect();
                const style = getComputedStyle(btn);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return true;
                }
            }
        }
        return false;
    }

    function clickPlayButton() {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.textContent.trim() === '游玩') {
                btn.click();
                console.log('✅ 已点击游玩按钮');
                // 点击成功后发送通知
                if (isMonitoring) {
                    const botKey = GM_getValue(STORAGE_KEY.BOT_KEY, '');
                    if (botKey) {
                        const msg = formatBotMessage('✅ 网页重新登录成功，已恢复在线状态。');
                        sendWxBot(botKey, msg);
                    }
                    // 登录成功，清除登出通知标记，允许下次登出再次推送
                    GM_setValue(STORAGE_KEY.LOGOUT_NOTIFIED, false);
                }
                // 延迟重置登录标志，让页面有时间完成跳转
                setTimeout(() => {
                    if (!isMonitoring) return;
                    // 确认"即刻游玩"按钮已消失（真正登录成功）才重置
                    if (!isLoggedOut()) {
                        isLoggingIn = false;
                    }
                }, 5000);
                return true;
            }
        }
        console.log('⚠️ 未找到游玩按钮，等待重试...');
        return false;
    }

    function performAutoLogin() {
        if (!isMonitoring) return;
        // 防止重复触发登录流程
        if (isLoggingIn) return;
        isLoggingIn = true;

        // 发送登出通知（只在本次登出流程首次触发时推送一次。
        // 通过 LOGOUT_NOTIFIED 持久化标记确保：即使页面刷新/重载也不会重复推送）
        const botKey = GM_getValue(STORAGE_KEY.BOT_KEY, '');
        if (botKey && !GM_getValue(STORAGE_KEY.LOGOUT_NOTIFIED, false)) {
            const msg = formatBotMessage('⚠️ 检测到网页已登出，正在自动重新登录...');
            sendWxBot(botKey, msg);
            GM_setValue(STORAGE_KEY.LOGOUT_NOTIFIED, true);
        }

        // 点击「即刻游玩」按钮打开登录弹窗，然后等待弹窗出现
        tryClickPlayAndWait();
    }

    function tryClickPlayAndWait() {
        if (!isMonitoring) return;

        // 先检查登录输入框是否已可见（登录弹窗已打开）
        const existingInputs = findLoginInputs();
        if (existingInputs) {
            console.log('🔑 登录弹窗已打开，直接填充登录');
            fillAndLogin();
            return;
        }

        // 点击「即刻游玩」按钮打开登录弹窗
        const clicked = tryClickPlayButtonOnce();
        if (!clicked) {
            console.log('⚠️ 未找到「即刻游玩」按钮');
            isLoggingIn = false;
            return;
        }

        // 点击后等待登录弹窗完全出现（每 500ms 检查一次，最多 10 秒）
        waitForLoginForm(0);
    }

    function tryClickPlayButtonOnce() {
        const playButtons = document.querySelectorAll('button');
        for (const btn of playButtons) {
            if (btn.textContent.includes('即刻游玩')) {
                const rect = btn.getBoundingClientRect();
                const style = getComputedStyle(btn);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    btn.click();
                    console.log('🎣 点击「即刻游玩」按钮');
                    return true;
                }
            }
        }
        return false;
    }

    function waitForLoginForm(attempts) {
        if (!isMonitoring) return;
        if (attempts > 20) {
            console.log('⚠️ 登录弹窗未出现，停止等待');
            isLoggingIn = false;
            return;
        }

        // 查找登录输入框（「即刻游玩」按钮是否存在不影响判断，
        // 因为登录弹窗可能以模态框形式叠加在页面上方）
        const loginInputs = findLoginInputs();
        if (!loginInputs) {
            // 登录弹窗尚未打开
            console.log('⏳ 等待登录弹窗打开...');
            // 如果页面仍显示「即刻游玩」，尝试再次点击
            if (isLoggedOut()) {
                tryClickPlayButtonOnce();
            }
            setTimeout(() => waitForLoginForm(attempts + 1), 500);
            return;
        }

        console.log('✅ 登录弹窗已出现');

        // 从悬浮窗读取账号密码
        const savedUsername = GM_getValue(STORAGE_KEY.USERNAME, '');
        const savedPassword = GM_getValue(STORAGE_KEY.PASSWORD, '');

        if (!savedUsername || !savedPassword) {
            console.log('⚠️ 未配置账号密码，请在悬浮窗填写');
            statusText.textContent = '请填写账号密码';
            // 尝试直接点击登录，让用户看到错误
            tryClickLogin();
            return;
        }

        // 直接用悬浮窗配置的账号密码填充登录表单
        console.log('🔑 使用配置的账号密码填充登录表单...');
        setReactInputValue(loginInputs.account, savedUsername);
        setReactInputValue(loginInputs.password, savedPassword);

        // 验证填充结果
        setTimeout(() => {
            if (!isMonitoring) return;
            const current = findLoginInputs();
            if (!current) {
                setTimeout(() => waitForLoginForm(attempts + 1), 500);
                return;
            }

            // 再次确认值已设置
            const accountFilled = current.account.value.trim() !== '';
            const passwordFilled = current.password.value.trim() !== '';

            if (accountFilled && passwordFilled) {
                console.log('✅ 账号密码填充成功');
                tryClickLogin();
            } else if (accountFilled || passwordFilled) {
                // 部分填充成功，补充填充缺失的
                console.log('⚠️ 部分字段填充成功，补充剩余字段...');
                if (!accountFilled) {
                    setReactInputValue(current.account, savedUsername);
                }
                if (!passwordFilled) {
                    setReactInputValue(current.password, savedPassword);
                }
                setTimeout(() => tryClickLogin(), 300);
            } else {
                console.log('⚠️ 填充后值被清空，重试...');
                // 可能是 React 受控组件覆盖，尝试再次写入
                setReactInputValue(current.account, savedUsername);
                setReactInputValue(current.password, savedPassword);
                setTimeout(() => {
                    if (!isMonitoring) return;
                    const final = findLoginInputs();
                    if (final) {
                        // 第二次填充后无论结果如何都尝试登录
                        if (final.account.value.trim() === '' && savedUsername) {
                            // 强制赋值
                            setReactInputValue(final.account, savedUsername);
                        }
                        if (final.password.value.trim() === '' && savedPassword) {
                            setReactInputValue(final.password, savedPassword);
                        }
                        console.log('⚠️ 第二次填充完成，尝试登录...');
                        setTimeout(() => {
                            if (!isMonitoring) return;
                            tryClickLogin();
                        }, 300);
                    }
                }, 500);
            }
        }, 300);
    }

    function fillAndLogin() {
        // 直接登录弹窗已打开的场景：读取配置并填充
        const savedUsername = GM_getValue(STORAGE_KEY.USERNAME, '');
        const savedPassword = GM_getValue(STORAGE_KEY.PASSWORD, '');

        if (!savedUsername || !savedPassword) {
            console.log('⚠️ 未配置账号密码，请在悬浮窗填写');
            statusText.textContent = '请填写账号密码';
            isLoggingIn = false;
            return;
        }

        const loginInputs = findLoginInputs();
        if (!loginInputs) {
            isLoggingIn = false;
            return;
        }

        console.log('🔑 填充账号密码...');
        setReactInputValue(loginInputs.account, savedUsername);
        setReactInputValue(loginInputs.password, savedPassword);

        // 等待 React 状态同步后点击登录
        setTimeout(() => {
            if (!isMonitoring) return;
            const current = findLoginInputs();
            if (!current) {
                isLoggingIn = false;
                return;
            }

            if (current.account.value.trim() !== '' && current.password.value.trim() !== '') {
                tryClickLogin();
            } else {
                // 重试填充
                setReactInputValue(current.account, savedUsername);
                setReactInputValue(current.password, savedPassword);
                setTimeout(() => {
                    if (!isMonitoring) return;
                    tryClickLogin();
                }, 300);
            }
        }, 300);
    }

    function setReactInputValue(input, value) {
        // 使用 React Fiber 方式设置值
        try {
            // 查找 React 内部属性
            const propsKey = Object.keys(input).find(k => k.startsWith('__reactProps$'));
            const fiberKey = Object.keys(input).find(k => k.startsWith('__reactFiber$'));

            // 使用原生 setter 写入值（绕过 React 的 value 拦截）
            const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            valueSetter.call(input, value);

            if (propsKey) {
                // 直接调用 React 的 onChange
                const props = input[propsKey];
                if (typeof props.onChange === 'function') {
                    const event = {
                        target: input,
                        currentTarget: input,
                        preventDefault() {},
                        stopPropagation() {},
                        bubbles: true,
                        cancelable: true,
                        type: 'change',
                        persist() {}
                    };
                    props.onChange(event);
                }
                // 同时派发原生 input 事件
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (fiberKey) {
                // 通过 Fiber 查找 onChange
                let node = input[fiberKey];
                let memoizedProps = null;
                while (node) {
                    if (node.memoizedProps && typeof node.memoizedProps.onChange === 'function') {
                        memoizedProps = node.memoizedProps;
                        break;
                    }
                    node = node.return;
                }
                if (memoizedProps && typeof memoizedProps.onChange === 'function') {
                    const event = {
                        target: input,
                        currentTarget: input,
                        preventDefault() {},
                        stopPropagation() {},
                        bubbles: true,
                        cancelable: true,
                        type: 'change'
                    };
                    memoizedProps.onChange(event);
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                // 降级：直接设置并派发事件
                input.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    data: value,
                    inputType: 'insertText'
                }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // 额外：用输入法模拟输入（某些 React 组件需要）
            input.focus();
            valueSetter.call(input, '');
            input.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'deleteContentBackward'
            }));
            valueSetter.call(input, value);
            input.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                data: value,
                inputType: 'insertText'
            }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
            // 最后一招：直接赋值
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function findLoginInputs() {
        // 判断标准：登录页面的账号密码输入框 + type=submit 的登录按钮（与需求文档 outerHTML 一致）
        // 悬浮窗自身没有 submit 按钮，不会误判
        try {
            // 1. 先确认登录页面存在（找到 type=submit 且文本含「登录」的按钮，即需求中的登录按钮 HTML）
            let loginBtn = null;
            const allButtons = document.querySelectorAll('button[type="submit"]');
            for (const btn of allButtons) {
                const txt = (btn.textContent || '').trim();
                if (txt.includes('登录')) {
                    const rect = btn.getBoundingClientRect();
                    const style = getComputedStyle(btn);
                    if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                        loginBtn = btn;
                        break;
                    }
                }
            }
            // 没有登录按钮，说明不在登录页面
            if (!loginBtn) return null;

            // 2. 在登录页面内找账号密码输入框
            const inputs = Array.from(document.querySelectorAll('input'));
            const visibleInputs = inputs.filter(inp => {
                const rect = inp.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                // 确保不在隐藏的父容器内
                let parent = inp.parentElement;
                let inPanel = false;
                while (parent) {
                    if (parent.id === 'aa-monitor-panel') {
                        inPanel = true;
                        break;
                    }
                    const style = getComputedStyle(parent);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                        return false;
                    }
                    parent = parent.parentElement;
                }
                return !inPanel;
            });

            if (visibleInputs.length === 0) return null;

            // 密码输入框：type=password（登录页面必有一个）
            const password = visibleInputs.find(inp => inp.type === 'password');
            if (!password) return null;

            // 账号输入框：placeholder 为 "Enter username" 的可见输入框
            const account = visibleInputs.find(inp =>
                inp.type !== 'password' &&
                ((inp.placeholder || '').toLowerCase().includes('username') ||
                 (inp.placeholder || '').toLowerCase().includes('user') ||
                 (inp.name || '').toLowerCase() === 'username')
            );
            if (!account) return null;

            return { account, password };
        } catch (e) {
            return null;
        }
    }

    function setupReactInput(input) {
        // ============ 最可靠方案：直接调用 React Fiber 的 onChange ============
        try {
            // 找到 React 内部属性键（如 __reactProps$xxx 或 __reactFiber$xxx）
            const propsKey = Object.keys(input).find(k => k.startsWith('__reactProps$'));
            const fiberKey = Object.keys(input).find(k => k.startsWith('__reactFiber$'));

            const domValue = input.value;

            if (propsKey) {
                // React 受控组件：调用其 onChange/onInput 处理函数
                const props = input[propsKey];
                // 先设置原生 value（绕过 React value 拦截）
                const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                valueSetter.call(input, domValue);

                // 模拟真实用户输入事件
                if (typeof props.onChange === 'function') {
                    const event = {
                        target: input,
                        currentTarget: input,
                        nativeEvent: {
                            inputType: 'insertText',
                            data: domValue,
                            isTrusted: false
                        },
                        preventDefault() {},
                        stopPropagation() {},
                        bubbles: true,
                        cancelable: true,
                        type: 'change',
                        persist() {}
                    };
                    props.onChange(event);
                }

                // 同时派发 input 事件作为兜底
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (fiberKey) {
                // 通过 Fiber 触发
                const fiber = input[fiberKey];
                let memoizedProps = null;
                let node = fiber;
                while (node) {
                    if (node.memoizedProps && typeof node.memoizedProps.onChange === 'function') {
                        memoizedProps = node.memoizedProps;
                        break;
                    }
                    node = node.return;
                }

                const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                valueSetter.call(input, domValue);

                if (memoizedProps && typeof memoizedProps.onChange === 'function') {
                    const event = {
                        target: input,
                        currentTarget: input,
                        preventDefault() {},
                        stopPropagation() {},
                        bubbles: true,
                        cancelable: true,
                        type: 'change'
                    };
                    memoizedProps.onChange(event);
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                // 降级：标准 InputEvent 派发
                const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                valueSetter.call(input, domValue);
                input.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    data: domValue,
                    inputType: 'insertText',
                    isComposing: false
                }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) {
            // 最后的兜底
            try {
                const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                valueSetter.call(input, input.value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e2) {
                input.value = input.value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }

    function tryClickLogin() {
        // 每次都重新查找登录按钮（防止 DOM 重渲染导致引用失效）
        const loginBtn = document.querySelector('button[type="submit"]');
        if (loginBtn && (loginBtn.textContent.includes('登录') || loginBtn.type === 'submit')) {
            // 先尝试获取当前输入值
            const current = findLoginInputs();
            if (current) {
                // 检查是否已有值（浏览器可能已经填充）
                if (current.account.value.trim() !== '' || current.password.value.trim() !== '') {
                    // 同步 React 状态（使用 Fiber 或事件派发）
                    setupReactInput(current.account);
                    setupReactInput(current.password);
                }
            }

            // 点击登录按钮（如果 disabled 则等待启用后再点）
            const doClick = () => {
                if (!isMonitoring) return;
                // 重新获取当前按钮引用
                const btn = document.querySelector('button[type="submit"]');
                if (btn && !btn.disabled) {
                    btn.click();
                    console.log('✅ 已点击登录按钮');
                } else if (btn && btn.disabled) {
                    // 按钮 disabled，等待 500ms 后重试
                    console.log('⏳ 登录按钮尚未启用，等待...');
                    setTimeout(doClick, 500);
                } else {
                    console.log('⚠️ 登录按钮已移除');
                }
            };
            setTimeout(doClick, 300);

            // 等待跳转后点击游玩按钮
            setTimeout(() => {
                if (!isMonitoring) return;
                const clickedPlay = clickPlayButton();
                if (!clickedPlay) {
                    // 等待跳转后重试
                    let retryCount = 0;
                    const retryPlay = () => {
                        if (!isMonitoring) return;
                        retryCount++;
                        const ok = clickPlayButton();
                        if (!ok && retryCount < 10) {
                            setTimeout(retryPlay, 2000);
                        } else if (!ok) {
                            isLoggingIn = false;
                        }
                    };
                    setTimeout(retryPlay, 2000);
                }
            }, 3000);
        } else {
            // 未找到登录按钮，可能弹窗还没完全出来，继续等待
            console.log('⚠️ 未找到登录按钮，继续等待...');
            setTimeout(() => waitForLoginForm(0), 1000);
        }
    }

    function checkAndLogin() {
        if (!isMonitoring) return;

        if (isLoggedOut()) {
            console.log('🚨 检测到网页已登出');
            // 只有在没有正在进行的登录流程时才触发
            if (!isLoggingIn) {
                performAutoLogin();
            }
        }

        // 每隔2秒检查一次
        setTimeout(checkAndLogin, 2000);
    }

    // ==================== 组队/船长状态 ====================
    // 使用 unsafeWindow 访问页面真实上下文（原脚本 @grant none 直接运行在页面中）
    const realWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    // 当前的组队状态（供生态区域切换逻辑判断使用）
    let currentBoatState = 'unset'; // 'none' | 'leader' | 'member'
    let autoBiomeTimer = null;

    function installBoatInterceptor() {
        // 通过注入 <script> 到页面真实上下文：
        // 1) hook 页面自身 fetch 捕获 /api/boats/my-boat 响应
        // 2) 每 3 秒主动请求该接口，结果写入页面全局 window.__aaBoatData
        // 沙箱侧通过轮询读取该全局变量（跨沙箱传数据最可靠方式）
        try {
            const script = document.createElement('script');
            script.textContent = `(function() {
                if (window.__aaBoatHooked) return;
                window.__aaBoatHooked = true;
                window.__aaBoatData = null;

                const originalFetch = window.fetch.bind(window);
                window.fetch = async function(input, init) {
                    const response = await originalFetch(input, init);
                    try {
                        const url = input instanceof Request ? input.url : String(input);
                        const path = new URL(url, window.location.href).pathname;
                        if (path === '/api/boats/my-boat' && response.ok) {
                            try {
                                const clone = response.clone();
                                clone.json().then(function(data) {
                                    window.__aaBoatData = data;
                                }).catch(function(){});
                            } catch (e) {}
                        }
                    } catch (e) {}
                    return response;
                };

                // 立即主动请求一次，作为初始数据
                fetch('/api/boats/my-boat', {
                    method: 'GET',
                    credentials: 'include',
                    headers: { 'Accept': 'application/json' }
                }).then(function(res) { return res.ok ? res.json() : null; })
                  .then(function(data) { if (data) window.__aaBoatData = data; })
                  .catch(function(){});

                // 每 3 秒刷新一次
                setInterval(function() {
                    fetch('/api/boats/my-boat', {
                        method: 'GET',
                        credentials: 'include',
                        headers: { 'Accept': 'application/json' }
                    }).then(function(res) { return res.ok ? res.json() : null; })
                      .then(function(data) { if (data) window.__aaBoatData = data; })
                      .catch(function(){});
                }, 3000);
            })();`;
            (document.head || document.documentElement).appendChild(script);
            script.remove();
        } catch (e) {
            console.error('[组队状态] 注入脚本失败:', e);
        }
    }

    function updateBoatStatus() {
        // 读取页面全局变量中的组队数据（由注入脚本填充）
        const data = realWindow.__aaBoatData;
        if (data) {
            processBoatData(data);
            return;
        }
        setBoatStatus('未检测', '');
    }

    function processBoatData(data) {
        // data 即为 player.boat：{ role: "leader" | "member" | ... }
        // 若请求 200 但无有效角色，尝试从返回结构中提取
        let boat = data?.boat ?? data?.data ?? data;
        // 兼容返回包裹格式（如 { boat: {...} } 或 { data: {...} }）
        if (boat && !('role' in boat) && typeof boat === 'object') {
            boat = boat.boat ?? boat.data ?? null;
        }

        if (!boat) {
            // 请求成功但无 boat 数据（可能未组队时接口返回空对象/特定结构）
            // 这里我方请求可拿到数据时视为未组队（绿灯）
            setBoatStatus('未组队', 'green');
            return;
        }

        if (boat.role === 'leader') {
            currentBoatState = 'leader';
            setBoatStatus('组队中·队长', 'green');
        } else if (boat.role && boat.role !== 'none') {
            currentBoatState = 'member';
            setBoatStatus('组队中·队员', 'red');
        } else {
            currentBoatState = 'none';
            setBoatStatus('未组队', 'green');
        }
    }

    function setBoatStatus(text, color) {
        if (!boatDot || !boatText) return;
        if (boatDot === null || boatText === null) return;
        boatText.textContent = text;
        boatDot.className = 'aa-dot';
        if (color === 'green') {
            boatDot.classList.add('aa-dot-green');
        } else if (color === 'red') {
            boatDot.classList.add('aa-dot-red');
        }
    }

    function startBoatStatusPolling() {
        // 每 3 秒更新一次组队/船长状态
        updateBoatStatus();
        setInterval(updateBoatStatus, 3000);
        // 每 4-6 分钟自动切换生态区域（队长/未组队时）
        startAutoBiomeSwitcher();
        // 每天定时点击任务按钮
        startDailyQuestClicker();
        // 每天定时领取每日登录奖励
        startDailyLoginReward();
        // 监控 Access token 弹窗
        startTokenAlertWatcher();
        // 监控作者问题弹窗
        startAuthorQuestionWatcher();
        // 监控自动抛竿会话弹窗
        startCastSessionPopupWatcher();
    }

    // ==================== 自动切换生态区域 ====================
    function startAutoBiomeSwitcher() {
        if (autoBiomeTimer) return;
        const tick = () => {
            scheduleNextBiome(); // 先安排好下一次，让倒计时从切换完成后立即重新开始
            autoBiomeTimer = setTimeout(() => {
                doBiomeSwitch(() => {
                    // 切换完成后安排下一次
                    tick();
                });
            }, remainingDelay());
        };
        // 先安排第一次（从当前开始算 4-6 分钟）
        scheduleNextBiome();
        autoBiomeTimer = setTimeout(() => {
            doBiomeSwitch(() => {
                tick();
            });
        }, remainingDelay());
    }

    function remainingDelay() {
        return nextBiomeTime ? nextBiomeTime - Date.now() : getBiomeDelay();
    }

    function getBiomeDelay() {
        // 4-5 分钟随机
        return (4 + Math.random() * 1) * 60 * 1000;
    }

    function scheduleNextBiome() {
        const delay = getBiomeDelay();
        nextBiomeTime = Date.now() + delay;
        startBiomeCountdown();
        return delay;
    }

    function startBiomeCountdown() {
        if (biomeCountdownTimer) clearInterval(biomeCountdownTimer);
        biomeCountdownTimer = setInterval(() => {
            if (!biomeCountdownEl) return;
            // 未登录状态显示
            if (isLoggedOut()) {
                biomeCountdownEl.textContent = '未登录';
                return;
            }
            // 队员状态
            if (currentBoatState === 'member') {
                biomeCountdownEl.textContent = '无需切换界面';
                return;
            }
            if (!nextBiomeTime) {
                biomeCountdownEl.textContent = '未检测';
                return;
            }
            const remain = nextBiomeTime - Date.now();
            if (remain <= 0) {
                biomeCountdownEl.textContent = '正在切换';
                return;
            }
            const totalSec = Math.ceil(remain / 1000);
            const min = Math.floor(totalSec / 60);
            const sec = totalSec % 60;
            biomeCountdownEl.textContent = `${min}分${String(sec).padStart(2, '0')}秒后切换界面`;
        }, 1000);
    }

    function doBiomeSwitch(onDone) {
        // 仅已登录状态下执行
        if (isLoggedOut()) {
            console.log('[生态区域] 未登录，跳过切换');
            onDone && onDone();
            return;
        }
        // 仅当未组队或队长时执行；队员状态跳过
        if (currentBoatState === 'member') {
            console.log('[生态区域] 队员状态，跳过切换');
            onDone && onDone();
            return;
        }

        try {
            // 1. 点击「生态区域」按钮
            const biomeBtn = findButtonByText('生态区域');
            if (!biomeBtn) {
                console.warn('[生态区域] 未找到「生态区域」按钮');
                onDone && onDone();
                return;
            }
            biomeBtn.click();
            console.log('[生态区域] 已点击「生态区域」按钮');

            // 2. 等待出现「选择生态区」标题
            waitForElement(
                'h2', '选择生态区', 3000,
                () => {
                    // 3. 1-2 秒后点击「钓鱼」按钮
                    setTimeout(() => {
                        const fishBtn = findButtonByText('钓鱼');
                        if (!fishBtn) {
                            console.warn('[生态区域] 未找到「钓鱼」按钮');
                            onDone && onDone();
                            return;
                        }
                        fishBtn.click();
                        console.log('[生态区域] 已点击「钓鱼」按钮');

                        // 4. 等待出现「钓鱼总属性」标题确认成功
                        waitForElement(
                            'h3', '钓鱼总属性', 3000,
                            () => {
                                console.log('[生态区域] 切换成功，已进入钓鱼界面');
                                onDone && onDone();
                            },
                            () => {
                                console.warn('[生态区域] 未检测到钓鱼界面');
                                onDone && onDone();
                            }
                        );
                    }, 1500);
                },
                () => {
                    console.warn('[生态区域] 未出现「选择生态区」界面');
                    onDone && onDone();
                }
            );
        } catch (e) {
            console.error('[生态区域] 切换出错:', e);
            onDone && onDone();
        }
    }

    function findButtonByText(text) {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if ((btn.textContent || '').trim() === text) {
                const rect = btn.getBoundingClientRect();
                const style = getComputedStyle(btn);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return btn;
                }
            }
        }
        return null;
    }

    function waitForElement(tag, text, timeout, onFound, onTimeout) {
        const start = Date.now();
        const check = () => {
            if (!isMonitoring) return;
            const els = document.querySelectorAll(tag);
            for (const el of els) {
                if ((el.textContent || '').includes(text)) {
                    onFound && onFound();
                    return;
                }
            }
            if (Date.now() - start < timeout) {
                setTimeout(check, 200);
            } else {
                onTimeout && onTimeout();
            }
        };
        check();
    }

    // ==================== Access token 弹窗监控 ====================
    function startTokenAlertWatcher() {
        // 每 2 秒检查一次 Access token 弹窗（仅登录状态）
        setInterval(checkTokenAlert, 2000);
    }

    function checkTokenAlert() {
        // 不论是否已登录状态，都执行检测
        if (!isMonitoring) return;

        const tokenAlertEl = findTokenAlertElement();
        if (!tokenAlertEl) return;

        // 使用持久化时间戳防止短时间反复刷新（token 持续失效时避免无限刷新/刷屏）
        const now = Date.now();
        const lastReloadAt = GM_getValue(STORAGE_KEY.TOKEN_ALERT_RELOAD_AT, 0);
        if (now - lastReloadAt < 5 * 60 * 1000) {
            return;
        }

        console.log('🔔 检测到 Access token required 弹窗');

        // 推送微信消息告知用户
        const botKey = GM_getValue(STORAGE_KEY.BOT_KEY, '');
        if (botKey) {
            const msg = formatBotMessage('⚠️ 游戏内弹窗提示 Access token required');
            sendWxBot(botKey, msg);
        }

        // 记录刷新时间并刷新页面
        GM_setValue(STORAGE_KEY.TOKEN_ALERT_RELOAD_AT, now);
        location.reload();
    }

    function findTokenAlertElement() {
        const divs = document.querySelectorAll('div');
        for (const div of divs) {
            const text = (div.textContent || '').trim();
            if (text.includes('Access token required')) {
                const rect = div.getBoundingClientRect();
                const style = getComputedStyle(div);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return div;
                }
            }
        }
        return null;
    }

    // ==================== 作者问题弹窗监控 ====================
    let authorQuestionHandling = false;
    let authorQuestionTimer = null;

    function startAuthorQuestionWatcher() {
        // 每 2 秒检查一次作者问题弹窗（仅登录状态）
        setInterval(checkAuthorQuestion, 2000);
    }

    function checkAuthorQuestion() {
        // 仅在已登录状态下监控
        if (isLoggedOut() || !isMonitoring) return;
        // 正在处理中，避免重复推送
        if (authorQuestionHandling) return;

        const input = findAnswerInput();
        const answerBtn = findAnswerButton();
        const questionEl = findQuestionElement(input);

        // 弹窗判断：输入框或 Answer 按钮至少出现一个
        if (!input && !answerBtn) {
            authorQuestionHandling = false;
            if (authorQuestionTimer) {
                clearTimeout(authorQuestionTimer);
                authorQuestionTimer = null;
            }
            return;
        }

        authorQuestionHandling = true;

        const questionText = questionEl ? (questionEl.textContent || '').trim() : '';
        const questionOk = !!questionEl;
        const inputOk = !!input;
        const btnOk = !!answerBtn;

        console.log(`🔔 检测到作者问题弹窗，题目：${questionText || '未识别'}`);

        // 推送微信消息告知用户题目及识别结果
        const botKey = GM_getValue(STORAGE_KEY.BOT_KEY, '');
        if (botKey) {
            const lines = [
                '🔔 检测到作者问题弹窗',
                `题目：${questionText || '未识别'}`,
                `输入框识别：${inputOk ? '成功' : '失败'}`,
                `Answer按钮识别：${btnOk ? '成功' : '失败'}`
            ];
            sendWxBot(botKey, formatBotMessage(lines.join('\n')));
        }

        // 三个元素都识别成功，才在题目出现后 2分40秒再次检测并处理
        if (questionOk && inputOk && btnOk) {
            if (authorQuestionTimer) clearTimeout(authorQuestionTimer);
            authorQuestionTimer = setTimeout(() => {
                if (!isMonitoring) return;
                handleAuthorQuestionAfterDelay();
            }, 160 * 1000);
        }
    }

    function handleAuthorQuestionAfterDelay() {
        // 再次检测弹窗是否仍存在
        const input = findAnswerInput();
        const answerBtn = findAnswerButton();
        if (!input && !answerBtn) {
            console.log('✅ 作者问题弹窗已消失，无需处理');
            authorQuestionHandling = false;
            return;
        }
        if (!input) {
            console.log('⚠️ 输入框已消失，无法输入');
            return;
        }

        // 输入"抱歉，我看不懂题目"
        setReactInputValue(input, '抱歉，我看不懂题目');
        console.log('⌨️ 已输入「抱歉，我看不懂题目」');

        // 等待 Answer 按钮启用后点击
        const doClick = (attempts) => {
            if (!isMonitoring) return;
            const btn = findAnswerButton();
            if (btn && !btn.disabled) {
                btn.click();
                console.log('✅ 已点击 Answer 按钮');
                const botKey = GM_getValue(STORAGE_KEY.BOT_KEY, '');
                if (botKey) {
                    const msg = formatBotMessage('已自行输入「看不懂题目」并点击 Answer 按钮');
                    sendWxBot(botKey, msg);
                }
            } else if (btn && btn.disabled && attempts < 10) {
                console.log('⏳ Answer 按钮尚未启用，等待...');
                setTimeout(() => doClick(attempts + 1), 500);
            } else {
                console.log('⚠️ Answer 按钮不可用或已消失');
            }
        };
        setTimeout(() => doClick(0), 500);
    }

    function findQuestionElement(input) {
        if (!input) return null;
        // 优先：输入框上方最近的非空 div
        let prev = input.previousElementSibling;
        while (prev) {
            if (prev.tagName === 'DIV') {
                const text = (prev.textContent || '').trim();
                if (text) return prev;
            }
            prev = prev.previousElementSibling;
        }
        // 兜底：向上找容器内不含 input/button 的非空 div
        let container = input.parentElement;
        while (container) {
            const divs = container.querySelectorAll('div');
            for (const div of divs) {
                const text = (div.textContent || '').trim();
                if (text && !div.querySelector('input') && !div.querySelector('button')) {
                    return div;
                }
            }
            container = container.parentElement;
        }
        return null;
    }

    function findAnswerInput() {
        const inputs = document.querySelectorAll('input[type="text"]');
        for (const inp of inputs) {
            const ph = (inp.placeholder || '').toLowerCase();
            if (ph.includes('answer')) {
                const rect = inp.getBoundingClientRect();
                const style = getComputedStyle(inp);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return inp;
                }
            }
        }
        return null;
    }

    function findAnswerButton() {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text.includes('answer')) {
                const rect = btn.getBoundingClientRect();
                const style = getComputedStyle(btn);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return btn;
                }
            }
        }
        return null;
    }

    // ==================== 自动抛竿会话弹窗处理 ====================
    const CAST_SESSION_POPUPS = [
        { contentKeyword: '已有自动抛竿会话在进行中', buttonKeyword: '确认', handling: false },
        { contentKeyword: '上一个自动抛竿会话已停止', buttonKeyword: '确定', handling: false },
        { contentKeyword: '自动抛竿失败。已停止自动抛竿', buttonKeyword: '确定', handling: false }
    ];

    function startCastSessionPopupWatcher() {
        // 每 2 秒检查一次自动抛竿会话弹窗（仅登录状态）
        setInterval(checkCastSessionPopup, 2000);
    }

    function checkCastSessionPopup() {
        // 不论是否已登录状态，都执行检测
        if (!isMonitoring) return;

        for (const cfg of CAST_SESSION_POPUPS) {
            const contentEl = findPopupContent(cfg.contentKeyword);
            if (contentEl) {
                // 该弹窗已在处理中，跳过
                if (cfg.handling) continue;
                cfg.handling = true;
                handleCastSessionPopup(cfg, contentEl);
            } else {
                // 弹窗不存在：重置处理标记
                cfg.handling = false;
            }
        }
    }

    function handleCastSessionPopup(cfg, contentEl) {
        const contentText = (contentEl.textContent || '').trim();
        console.log(`🔔 检测到自动抛竿会话弹窗：${contentText}`);

        // 点击确认/确定按钮
        const buttonEl = findPopupButton(cfg.buttonKeyword);
        if (buttonEl) {
            buttonEl.click();
            console.log(`✅ 已点击按钮：${buttonEl.textContent.trim()}`);
        } else {
            console.warn(`⚠️ 未找到按钮：${cfg.buttonKeyword}`);
        }

        // 推送微信消息告知用户弹窗内容及处理结果
        const botKey = GM_getValue(STORAGE_KEY.BOT_KEY, '');
        if (botKey) {
            const msg = formatBotMessage(`🔔 检测到弹窗\n内容：${contentText}\n✅ 已处理弹窗`);
            sendWxBot(botKey, msg);
        }
    }

    function findPopupContent(keyword) {
        const divs = document.querySelectorAll('div');
        for (const div of divs) {
            const text = (div.textContent || '').trim();
            if (text.includes(keyword)) {
                const rect = div.getBoundingClientRect();
                const style = getComputedStyle(div);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return div;
                }
            }
        }
        return null;
    }

    function findPopupButton(keyword) {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (text.includes(keyword)) {
                const rect = btn.getBoundingClientRect();
                const style = getComputedStyle(btn);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return btn;
                }
            }
        }
        return null;
    }

    // ==================== 检测并重启他人自动钓鱼脚本 ====================
    function restartOtherScriptIfNeeded() {
        // 通过注入 <script> 到页面真实上下文，持续等待并点击他人脚本按钮。
        // 他人脚本的 #toggle 按钮可能在 Dismiss 弹窗关闭后的延迟才渲染，
        // 因此这里最长等待约 15 秒，每 500ms 轮询直到找到按钮。
        try {
            const script = document.createElement('script');
            script.textContent = `(function() {
                // 递归穿透 iframe + shadow DOM 查找 #toggle 启动/停止按钮（已在控制台验证可行）
                function findToggle(root) {
                    if (root == null) return null;
                    var doc = root.document || root;
                    var nodes;
                    try { nodes = doc.querySelectorAll('*'); } catch (e) { return null; }
                    for (var i = 0; i < nodes.length; i++) {
                        var el = nodes[i];
                        if (el.tagName === 'BUTTON' && el.id === 'toggle') return el;
                        if (el.tagName === 'BUTTON') {
                            var t = (el.textContent || '').trim();
                            if ((t === '启动' || t === '停止') &&
                                (el.className === 'toggle' || (el.classList && el.classList.contains('toggle')))) {
                                return el;
                            }
                        }
                        if (el.shadowRoot) {
                            var found = findToggle(el.shadowRoot);
                            if (found) return found;
                        }
                        if (el.tagName === 'IFRAME') {
                            try {
                                var f = findToggle(el.contentDocument);
                                if (f) return f;
                            } catch (e) {}
                        }
                    }
                    return null;
                }

                console.log('[重启] 注入脚本已加载（iframe+shadow 深度搜索）');
                var startTime = Date.now();
                var poll = function() {
                    var btn = findToggle(document);
                    if (btn) {
                        handle(btn);
                        return;
                    }
                    if (Date.now() - startTime < 15000) {
                        setTimeout(poll, 500);
                    } else {
                        console.warn('[重启] 15 秒内未找到按钮');
                        window.__aaRestartResult = 'notfound';
                    }
                };

                function handle(btn) {
                    if (btn.dataset.enabled === 'true') {
                        console.log('[重启] 自动钓鱼脚本仍在运行');
                        window.__aaRestartResult = 'running';
                        return;
                    }
                    console.log('[重启] 检测到脚本已停止，点击启动...');
                    btn.click();
                    var attempts = 0;
                    var check = function() {
                        var b = findToggle(document);
                        if (b && b.dataset.enabled === 'true') {
                            console.log('[重启] 已重新启动成功');
                            window.__aaRestartResult = 'started';
                        } else if (attempts < 8) {
                            attempts++;
                            var b2 = findToggle(document);
                            if (b2 && b2.dataset.enabled !== 'true') b2.click();
                            setTimeout(check, 500);
                        } else {
                            console.warn('[重启] 启动失败');
                            window.__aaRestartResult = 'failed';
                        }
                    };
                    setTimeout(check, 500);
                }

                poll();
            })();`;
            (document.head || document.documentElement).appendChild(script);
            script.remove();
        } catch (e) {
            console.error('[重启] 注入脚本失败:', e);
        }

        // 沙箱侧轮询读取页面注入脚本的结果，成功后推送微信
        let pollCount = 0;
        const pollResult = () => {
            pollCount++;
            const res = realWindow.__aaRestartResult;
            if (res === 'started') {
                console.log('✅ 自动钓鱼脚本已重新启动成功');
                const botKey = GM_getValue(STORAGE_KEY.BOT_KEY, '');
                if (botKey) {
                    const msg = formatBotMessage('✅ 自动钓鱼脚本重新启动成功');
                    sendWxBot(botKey, msg);
                }
                realWindow.__aaRestartResult = null;
            } else if ((res === 'notfound' || res === 'running' || res === 'failed') || pollCount > 40) {
                realWindow.__aaRestartResult = null;
            } else if (pollCount <= 40) {
                setTimeout(pollResult, 500);
            }
        };
        setTimeout(pollResult, 500);
    }

    // ==================== 每日任务按钮点击 ====================
    let dailyQuestTimer = null;
    let nextQuestTime = null;

    function startDailyQuestClicker() {
        if (dailyQuestTimer) return;
        // 立即计算并安排今天（08:05-08:15 随机）的执行时间
        scheduleDailyQuest();
        // 每 30 秒检查一次是否为到点（也处理跨天后重新安排）
        dailyQuestTimer = setInterval(() => {
            // 到点执行
            dailyQuestTick();
            // 已过期且今天未执行过，重新安排（跨天场景）
            if (nextQuestTime && Date.now() > nextQuestTime.getTime() + 60 * 1000) {
                scheduleDailyQuest();
            } else if (nextQuestTime === null) {
                scheduleDailyQuest();
            }
        }, 30000);
    }

    function scheduleDailyQuest() {
        // 每天 08:05:00 - 08:14:59 随机一个时间
        const now = new Date();
        const target = new Date(now);
        target.setHours(8, 5 + Math.floor(Math.random() * 10), 0, 0); // 08:05 ~ 08:14 随机分钟
        // 若目标时间已过今天，则顺延到明天同一时间
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }
        nextQuestTime = target;
        console.log(`[任务] 已安排今日任务点击时间：${target.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    }

    function dailyQuestTick() {
        // 到点执行
        if (!nextQuestTime) return;
        if (Date.now() < nextQuestTime.getTime()) return;

        // 安排在每周/每天的这个时间执行
        doQuestClick();
        // 执行后安排下一天
        scheduleDailyQuest();
    }

    function doQuestClick() {
        // 仅登录状态下执行
        if (isLoggedOut()) {
            console.log('[任务] 未登录，跳过任务点击');
            return;
        }

        try {
            // 1. 点击「任务」按钮
            const questBtn = findButtonByText('任务');
            if (!questBtn) {
                console.warn('[任务] 未找到「任务」按钮');
                return;
            }
            questBtn.click();
            console.log('[任务] 已点击「任务」按钮');

            // 2. 等待出现「任务板」标题
            waitForElement(
                'h2', '任务板', 3000,
                () => {
                    // 3. 停留 2 秒后点击「钓鱼」按钮切换回来
                    setTimeout(() => {
                        const fishBtn = findButtonByText('钓鱼');
                        if (!fishBtn) {
                            console.warn('[任务] 未找到「钓鱼」按钮');
                            return;
                        }
                        fishBtn.click();
                        console.log('[任务] 已点击「钓鱼」按钮');

                        // 4. 等待「钓鱼总属性」确认回到钓鱼页面
                        waitForElement(
                            'h3', '钓鱼总属性', 3000,
                            () => {
                                console.log('[任务] 已成功回到钓鱼页面');
                                // 发送微信推送告知用户
                                const botKey = GM_getValue(STORAGE_KEY.BOT_KEY, '');
                                if (botKey) {
                                    const msg = formatBotMessage('✅ 已成功点击任务页面并返回钓鱼页面');
                                    sendWxBot(botKey, msg);
                                }
                            },
                            () => console.warn('[任务] 未检测到返回钓鱼页面')
                        );
                    }, 2000);
                },
                () => console.warn('[任务] 未出现「任务板」界面')
            );
        } catch (e) {
            console.error('[任务] 执行出错:', e);
        }
    }

    // ==================== 每日登录奖励领取 ====================
    let dailyRewardTimer = null;
    let nextDailyRewardTime = null;
    let rewardProcessing = false;

    function startDailyLoginReward() {
        if (dailyRewardTimer) return;
        // 安排今天 08:10-08:15 随机时间
        scheduleDailyReward();
        // 每 30 秒检查：到点主动领取；其余时间检测黄色按钮
        dailyRewardTimer = setInterval(dailyRewardTick, 30000);
        // 监控自动弹出的每日奖励页面
        startDailyRewardPopupWatcher();
    }

    function scheduleDailyReward() {
        // 每天 08:10:00 - 08:15:00 随机一个时间
        const now = new Date();
        const target = new Date(now);
        target.setHours(8, 10 + Math.floor(Math.random() * 6), 0, 0);
        if (target <= now) {
            target.setDate(target.getDate() + 1);
        }
        nextDailyRewardTime = target;
        console.log(`[奖励] 已安排每日奖励领取时间：${target.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    }

    function dailyRewardTick() {
        // 仅在已登录状态下执行
        if (isLoggedOut()) return;
        if (rewardProcessing) return;

        // 到点主动触发
        if (nextDailyRewardTime && Date.now() >= nextDailyRewardTime.getTime()) {
            console.log('[奖励] 到达每日奖励领取时间');
            doDailyReward(() => {
                scheduleDailyReward();
            });
            return;
        }

        // 其余时间：检测黄色入口按钮，若存在则领取
        const entryBtn = findDailyRewardButton();
        if (entryBtn && isYellowEntry(entryBtn)) {
            console.log('[奖励] 检测到黄色入口按钮，执行领取');
            doDailyReward();
        }
    }

    // 查找「每日登录奖励」入口按钮（按 title 或文本精确「每日」判断，兼容汉化）
    function findDailyRewardButton() {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            const title = (btn.title || '').trim().toLowerCase();
            const txt = (btn.textContent || '').trim();
            const titleMatch = title.includes('daily login reward') || title.includes('每日登录奖励');
            const textMatch = txt === '每日';
            if (titleMatch || textMatch) {
                const rect = btn.getBoundingClientRect();
                const style = getComputedStyle(btn);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return btn;
                }
            }
        }
        return null;
    }

    // 判断入口按钮是否为黄色（未领取）
    function isYellowEntry(btn) {
        const cls = btn.className || '';
        return cls.includes('bg-yellow');
    }

    function doDailyReward(onDone) {
        // 仅在已登录状态下执行
        if (isLoggedOut()) {
            console.log('[奖励] 未登录，跳过每日奖励领取');
            onDone && onDone();
            return;
        }
        rewardProcessing = true;

        try {
            // 如果每日奖励页面已经自动打开，直接处理领取，不再点击入口按钮
            if (findRewardPanelTitle()) {
                console.log('[奖励] 每日奖励页面已打开，直接处理领取');
                waitForRewardContent(0, onDone);
                return;
            }

            const entryBtn = findDailyRewardButton();
            if (!entryBtn) {
                console.log('[奖励] 未找到每日登录奖励入口按钮');
                rewardProcessing = false;
                onDone && onDone();
                return;
            }

            entryBtn.click();
            console.log('[奖励] 已点击「每日」入口按钮');

            waitForElement(
                'h2', '每日登录奖励', 10000,
                () => {
                    waitForRewardContent(0, onDone);
                },
                () => {
                    console.warn('[奖励] 未出现「每日登录奖励」面板，主动关闭面板');
                    closeRewardPanel(() => {
                        rewardProcessing = false;
                        onDone && onDone();
                    });
                }
            );
        } catch (e) {
            console.error('[奖励] 执行出错:', e);
            rewardProcessing = false;
            onDone && onDone();
        }
    }

    // 等待每日奖励面板内的领取按钮或已领取提示渲染
    function waitForRewardContent(attempts, onDone) {
        // 最多等待 10 秒（20 次 × 500ms）
        if (attempts > 20) {
            console.warn('[奖励] 等待领取按钮/已领取提示超时，主动关闭面板');
            closeRewardPanel(() => {
                sendRewardMessage('failed');
                rewardProcessing = false;
                onDone && onDone();
            });
            return;
        }

        // 已领取提示
        if (findComeBackTomorrowText()) {
            console.log('[奖励] 检测到已领取提示，每日奖励已领取');
            closeRewardPanel(() => {
                sendRewardMessage('already');
                rewardProcessing = false;
                onDone && onDone();
            });
            return;
        }

        // 领取按钮
        const claimBtn = findClaimButton();
        if (claimBtn) {
            const claimText = (claimBtn.textContent || '').trim();
            console.log(`[奖励] 点击领取按钮：${claimText}`);
            claimBtn.click();

            let clickAttempts = 0;
            const checkClaimed = () => {
                clickAttempts++;
                const btn = findClaimButton();
                if (!btn) {
                    console.log('[奖励] ✅ 领取按钮已消失，领取成功');
                    closeRewardPanel(() => {
                        sendRewardMessage('claimed');
                        rewardProcessing = false;
                        onDone && onDone();
                    });
                    return;
                }
                if (clickAttempts <= 5) {
                    console.log(`[奖励] 领取按钮仍存在，重试 ${clickAttempts} 次`);
                    btn.click();
                    setTimeout(checkClaimed, 800);
                } else {
                    console.log('[奖励] 领取多次失败，停止本次操作');
                    closeRewardPanel(() => {
                        sendRewardMessage('failed');
                        rewardProcessing = false;
                        onDone && onDone();
                    });
                }
            };
            setTimeout(checkClaimed, 800);
            return;
        }

        // 两者都未出现，继续等待
        setTimeout(() => waitForRewardContent(attempts + 1, onDone), 500);
    }

    // 查找「每日登录奖励」页面标题（用于检测自动弹出的面板）
    function findRewardPanelTitle() {
        const h2s = document.querySelectorAll('h2');
        for (const h2 of h2s) {
            const text = (h2.textContent || '').trim();
            if (text.includes('每日登录奖励')) {
                const rect = h2.getBoundingClientRect();
                const style = getComputedStyle(h2);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return h2;
                }
            }
        }
        return null;
    }

    // 监控自动弹出的每日奖励页面
    function startDailyRewardPopupWatcher() {
        // 每 2 秒检测一次
        setInterval(checkDailyRewardPopup, 2000);
    }

    function checkDailyRewardPopup() {
        // 仅在已登录状态下执行
        if (isLoggedOut()) return;
        if (rewardProcessing) return;

        // 检测每日奖励页面标题是否出现（面板已自动打开）
        if (!findRewardPanelTitle()) return;

        console.log('[奖励] 检测到每日奖励页面自动弹出');
        rewardProcessing = true;
        waitForRewardContent(0, null);
    }

    // 判断每日奖励是否已领取（出现 "Come back tomorrow" 提示）
    function findComeBackTomorrowText() {
        const divs = document.querySelectorAll('div');
        for (const div of divs) {
            const text = (div.textContent || '').trim().toLowerCase();
            if (text.includes('come back tomorrow')) {
                const rect = div.getBoundingClientRect();
                const style = getComputedStyle(div);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return div;
                }
            }
        }
        return null;
    }

    // 查找「领取第 X 天奖励」按钮（按包含「领取」且含「奖励」判断）
    function findClaimButton() {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            const txt = (btn.textContent || '').trim();
            if (txt.includes('领取') && txt.includes('奖励')) {
                const rect = btn.getBoundingClientRect();
                const style = getComputedStyle(btn);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    return btn;
                }
            }
        }
        return null;
    }

    // 关闭每日奖励面板（点击 × 按钮）
    function closeRewardPanel(onDone) {
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
            const txt = (btn.textContent || '').trim();
            if (txt.includes('×')) {
                const rect = btn.getBoundingClientRect();
                const style = getComputedStyle(btn);
                if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
                    btn.click();
                    console.log('[奖励] 已点击 × 关闭面板');
                    if (onDone) setTimeout(onDone, 500);
                    return;
                }
            }
        }
        console.warn('[奖励] 未找到关闭按钮，跳过关闭');
        if (onDone) onDone();
    }

    // 推送每日奖励结果微信消息
    function sendRewardMessage(type) {
        const botKey = GM_getValue(STORAGE_KEY.BOT_KEY, '');
        if (!botKey) return;
        let msg;
        if (type === 'claimed') {
            msg = formatBotMessage('✅ 每日奖励领取成功');
        } else if (type === 'already') {
            msg = formatBotMessage('✅ 每日奖励已领取');
        } else {
            msg = formatBotMessage('⚠️ 每日奖励领取失败，请手动处理');
        }
        sendWxBot(botKey, msg);
        console.log(`[奖励] 已推送每日奖励消息：${type}`);
    }

    function startCheckFromPlay() {
        // 每次启动监控时，从「即刻游玩」按钮开始检查
        // 先检测当前页面是否有「即刻游玩」按钮
        if (!isLoggedOut()) {
            console.log('✅ 启动检查：未检测到登出（无「即刻游玩」按钮）');
            return;
        }

        // 有「即刻游玩」按钮，说明已登出，走完整自动登录流程
        console.log('🚨 启动检查：检测到已登出，开始自动登录');
        performAutoLogin();
    }

    // ==================== 样式 ====================
    GM_addStyle(`
        #aa-monitor-panel {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            user-select: none;
        }
        #aa-monitor-panel * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        .aa-panel-body {
            background: rgba(17, 24, 39, 0.95);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
            color: #e5e7eb;
            width: 300px;
            max-height: 90vh;
            overflow-y: auto;
        }
        .aa-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            background: rgba(6, 182, 212, 0.2);
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .aa-title {
            font-weight: 700;
            font-size: 14px;
            color: #06b6d4;
        }
        .aa-min-btn {
            background: transparent;
            border: none;
            color: #9ca3af;
            font-size: 16px;
            cursor: pointer;
            padding: 0 4px;
            line-height: 1;
        }
        .aa-min-btn:hover {
            color: #fff;
        }
        .aa-content {
            padding: 12px 14px;
        }
        .aa-label {
            display: block;
            font-size: 12px;
            color: #9ca3af;
            margin: 8px 0 4px;
        }
        .aa-input {
            width: 100%;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 6px;
            color: #e5e7eb;
            padding: 7px 10px;
            font-size: 13px;
            outline: none;
        }
        .aa-input:focus {
            border-color: #06b6d4;
        }
        .aa-input::placeholder {
            color: #6b7280;
        }
        .aa-actions {
            display: flex;
            gap: 8px;
            margin-top: 14px;
        }
        .aa-btn {
            flex: 1;
            border: none;
            border-radius: 6px;
            padding: 8px 0;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }
        .aa-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .aa-btn-start {
            background: #06b6d4;
            color: #fff;
        }
        .aa-btn-start:hover:not(:disabled) {
            background: #0891b2;
        }
        .aa-btn-stop {
            background: #4b5563;
            color: #fff;
        }
        .aa-btn-stop:hover:not(:disabled) {
            background: #374151;
        }
        .aa-status {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 10px;
        }
        .aa-status-left,
        .aa-status-right {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 12px;
            color: #9ca3af;
        }
        .aa-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #ef4444;
            display: inline-block;
        }
        .aa-dot-active {
            background: #22c55e;
        }
        .aa-dot-green {
            background: #22c55e;
        }
        .aa-dot-red {
            background: #ef4444;
        }
        .aa-biome-countdown {
            margin-top: 8px;
            padding-top: 6px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 12px;
            color: #f59e0b;
            text-align: center;
        }
        .aa-restore-btn {
            display: none;
            background: rgba(17, 24, 39, 0.95);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 50%;
            color: #06b6d4;
            font-size: 18px;
            width: 38px;
            height: 38px;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
        }
        .aa-restore-btn:hover {
            background: rgba(17, 24, 39, 1);
        }
    `);

    // ==================== 初始化 ====================
    function init() {
        // 确保页面完全加载后再创建悬浮窗
        const panel = createFloatPanel();
        setupUI(panel);
        // 安装 fetch 拦截，捕获组队/船长接口响应
        installBoatInterceptor();
        // 开始轮询组队/船长状态（不依赖监控开关，一直保持）
        startBoatStatusPolling();
    }

    // 页面加载完成后启动
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(init, 300);
    } else {
        window.addEventListener('load', () => setTimeout(init, 300));
    }
})();

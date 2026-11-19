/**
 * dsh-plugin-boss — client half.
 *
 * Layout: left-sidebar entry (`sidebar.panellist`, panel id 'boss') plus the
 * keyed `main` page. The page carries session status and manual import; the
 * zhipin webview lives in a persistent floating window owned by the webview
 * host (below), so the session survives page switches inside the shell.
 *
 * Webview UX contract (per product decision): the window pops out only for
 * QR login (auto-hides once wt2 + __zp_stoken__ appear) or explicit
 * browsing; __zp_stoken__ rotation is automatic (periodic reload + harvest,
 * plus an immediate refresh whenever the host flags it stale), so the user
 * never harvests cookies by hand.
 *
 * Single-file constraint: the DSH ModuleLoader loads one factory per plugin
 * client (`dsh.client.platform: "web"`); sections below mark the seams where
 * a bundler would split modules.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-boss/client',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dshPluginBoss';
    const PANEL_ID = 'boss';
    // /web/user/ renders the login form (the .login-entry-page document) when
    // not signed in, and the user profile once authenticated.
    const LOGIN_URL = 'https://www.zhipin.com/web/user/';
    const COOKIE_DOMAIN = 'zhipin.com';
    /** Anti-crawler token rotation cadence; BOSS pages recompute it on load. */
    const STOKEN_REFRESH_MS = 20 * 60 * 1000;
    /** Login-watch poll cadence while the floating window waits for a QR scan. */
    const LOGIN_POLL_MS = 2000;
    /** Panel status poll; also drives the stale-stoken trigger. */
    const STATUS_POLL_MS = 15000;

    // ============================================================= locale

    const zh = {
      panel: 'BOSS 直聘', page: 'BOSS 直聘',
      subtitle: '登录一次，会话由插件保管，业务请求走本机 HTTP',
      loading: '正在读取会话状态…',
      loggedIn: '已登录', loggedOut: '未登录', partial: '部分会话',
      collected: '已采集', cookiesUnit: '项 cookie',
      source: '来源', savedAt: '更新于', missing: '缺少关键 cookie',
      httponlyHint: 'wt2 是 HttpOnly，页面脚本读不到。若采集仍缺 wt2，可从 DevTools → Application → Cookies 复制 wt2 的值，粘到左侧导入框（一行 wt2=值 即可）。',
      riskLock: '本地风控锁已触发，发送已暂停（boss_risk_unlock 解锁）',
      stokenRefreshing: '反爬令牌过期，正在通过内嵌页面自动轮换…',
      refresh: '刷新',
      importTitle: '手动导入会话',
      importHint: '在浏览器登录 zhipin.com 后，F12 → Network 任选请求 → Copy as cURL，粘贴到下面',
      placeholder: '粘贴 cookie 头（wt2=…; __zp_stoken__=…）或整段 curl 命令',
      importButton: '导入', importing: '导入中…', importOk: '导入成功',
      importPartial: '已导入，但缺少：', importFail: '导入失败',
      webviewTitle: '网页会话',
      webviewHintDesktop: '「登录」弹出网页窗口，扫码登录后自动收起并采集会话（含 HttpOnly）；「查看网页」随时打开浏览。反爬令牌由插件在后台自动轮换。',
      webviewUnsupported: '当前运行在 Web 版（无内嵌网页能力），请使用手动导入；桌面版支持扫码登录与自动轮换。',
      login: '登录', browse: '查看网页', hideWindow: '收起窗口',
      floatTitle: 'BOSS 直聘', floatWaitingLogin: '等待扫码登录…成功后自动收起', floatBrowse: '浏览模式',
      webviewError: '内嵌网页加载失败：',
      webviewHarvestOk: '登录成功，会话已采集',
      webviewHarvestFail: '会话采集失败',
    };
    const en = {
      panel: 'BOSS Zhipin', page: 'BOSS Zhipin',
      subtitle: 'Log in once; the plugin keeps the session, business calls stay on host HTTP',
      loading: 'Reading session…',
      loggedIn: 'Logged in', loggedOut: 'Not logged in', partial: 'Partial session',
      collected: 'Collected', cookiesUnit: 'cookies',
      source: 'Source', savedAt: 'Updated', missing: 'Missing required cookies',
      httponlyHint: 'wt2 is HttpOnly, invisible to page scripts. If a harvest still misses it, copy the wt2 value from DevTools → Application → Cookies into the manual import box (a single wt2=value line works).',
      riskLock: 'Local risk lock active — sending paused (unlock via boss_risk_unlock)',
      stokenRefreshing: 'Anti-crawler token expired; rotating it automatically via the embedded page…',
      refresh: 'Refresh',
      importTitle: 'Manual session import',
      importHint: 'Log in on zhipin.com, then DevTools → Network → any request → Copy as cURL, and paste below',
      placeholder: 'Paste a cookie header (wt2=…; __zp_stoken__=…) or a full curl command',
      importButton: 'Import', importing: 'Importing…', importOk: 'Imported',
      importPartial: 'Imported, missing:', importFail: 'Import failed',
      webviewTitle: 'Web session',
      webviewHintDesktop: '"Log in" opens the embedded window; after the QR login it hides itself and harvests the session (HttpOnly included). "Browse" reopens the page anytime. The anti-crawler token rotates automatically in the background.',
      webviewUnsupported: 'Running in the web build (no embedded view) — use manual import; the desktop shell supports QR login and automatic rotation.',
      login: 'Log in', browse: 'Browse', hideWindow: 'Hide window',
      floatTitle: 'BOSS Zhipin', floatWaitingLogin: 'Waiting for QR login… hides itself on success', floatBrowse: 'Browse mode',
      webviewError: 'Embedded view failed to load: ',
      webviewHarvestOk: 'Login captured; session stored',
      webviewHarvestFail: 'Session harvest failed',
    };

    let translate = (key) => zh[key] ?? key;

    function t(key) {
      return translate(key);
    }

    // ============================================================= styles

    const STYLE_ID = 'dsh-plugin-boss-style';
    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
.dsh-boss-page { display: block; padding: 16px 20px; font-size: 13px; height: 100%; box-sizing: border-box; overflow: auto; }
.dsh-boss-page h2 { margin: 0; font-size: 18px; }
.dsh-boss-subtitle { opacity: .7; margin: 4px 0 12px; }
/* Fixed minimum widths: a narrower window gets scrollbars on the page, never clipped content. */
.dsh-boss-cols { display: grid; grid-template-columns: minmax(280px, 340px) minmax(420px, 1fr); gap: 14px; min-width: 780px; }
.dsh-boss-card { border: 1px solid rgba(128,128,128,.25); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dsh-boss-card h4 { margin: 0; font-size: 12px; opacity: .75; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.dsh-boss-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsh-boss-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
.dsh-boss-badge.ok { background: rgba(46,160,67,.18); color: #2ea043; }
.dsh-boss-badge.bad { background: rgba(248,81,73,.16); color: #f85149; }
.dsh-boss-badge.warn { background: rgba(210,153,34,.18); color: #d29922; }
.dsh-boss-kv { opacity: .8; }
.dsh-boss-textarea { width: 100%; min-height: 96px; resize: vertical; border-radius: 6px; border: 1px solid rgba(128,128,128,.35); padding: 8px; font-family: ui-monospace, monospace; font-size: 12px; box-sizing: border-box; background: transparent; color: inherit; }
.dsh-boss-button { border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; padding: 5px 16px; cursor: pointer; font-size: 12px; }
.dsh-boss-button:hover:not(:disabled) { background: rgba(128,128,128,.12); }
.dsh-boss-button:disabled { opacity: .5; cursor: default; }
.dsh-boss-button.primary { border-color: rgba(0,122,255,.55); color: #007aff; }
.dsh-boss-msg { font-size: 12px; }
.dsh-boss-msg.ok { color: #2ea043; }
.dsh-boss-msg.bad { color: #f85149; }
.dsh-boss-msg.hint { opacity: .75; }
.dsh-boss-float { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(96vw, 1080px); height: min(92vh, 840px); z-index: 2147483000; display: flex; flex-direction: column; background: #fff; color: #111; border-radius: 12px; box-shadow: 0 24px 80px rgba(0,0,0,.45); overflow: hidden; }
.dsh-boss-float[hidden] { display: none; }
.dsh-boss-float-bar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: #00beab; color: #fff; flex: none; }
.dsh-boss-float-title { font-weight: 600; font-size: 13px; }
.dsh-boss-float-status { font-size: 12px; opacity: .92; flex: 1; }
.dsh-boss-float-close { border: none; background: rgba(255,255,255,.22); color: #fff; border-radius: 6px; width: 26px; height: 26px; cursor: pointer; font-size: 14px; line-height: 1; }
.dsh-boss-float-close:hover { background: rgba(255,255,255,.35); }
.dsh-boss-float-body { flex: 1; min-height: 0; position: relative; }
.dsh-boss-float-body webview { width: 100%; height: 100%; border: none; display: block; }
      `;
      document.head.appendChild(style);
    }

    // ======================================================= webview host
    // Persistent floating window owning the zhipin guest. Pure DOM — it never
    // unmounts with the page, which is what keeps the login (and the token
    // rotation loop) alive across panel switches.

    /**
     * @param {{onSessionChange?: () => void, onNotice?: (text: string, ok: boolean) => void}} callbacks
     */
    function createWebviewHost(callbacks = {}) {
      const bridge = typeof window !== 'undefined' ? window.dshDesktop?.browser : undefined;
      const state = { view: null, lease: null, mode: null, opening: null, refreshing: false, loginTimer: null, keepAlive: null };
      let root = null;
      /** Last harvest/rotation outcome; the page picks it up on its status poll. */
      const api = { lastNotice: null, available: Boolean(bridge), show, hide, refreshStoken, harvest, destroy };

      const notify = (text, isOk) => {
        api.lastNotice = { text, ok: isOk, at: Date.now() };
        callbacks.onNotice?.(text, isOk);
      };
      const changed = () => callbacks.onSessionChange?.();

      function ensureDom() {
        if (root) return root;
        root = document.createElement('div');
        root.className = 'dsh-boss-float';
        root.hidden = true;
        const bar = document.createElement('div');
        bar.className = 'dsh-boss-float-bar';
        const title = document.createElement('span');
        title.className = 'dsh-boss-float-title';
        title.textContent = t('floatTitle');
        const status = document.createElement('span');
        status.className = 'dsh-boss-float-status';
        const close = document.createElement('button');
        close.className = 'dsh-boss-float-close';
        close.textContent = '×';
        close.addEventListener('click', () => hide());
        bar.append(title, status, close);
        const body = document.createElement('div');
        body.className = 'dsh-boss-float-body';
        root.append(bar, body);
        root.addEventListener('click', (event) => { if (event.target === root) hide(); });
        document.body.appendChild(root);
        return root;
      }

      const setStatusText = (text) => {
        const el = ensureDom().querySelector('.dsh-boss-float-status');
        if (el && el.textContent !== text) el.textContent = text;
      };

      /** A redirect cancels the pending navigation with ERR_ABORTED; Electron reports it via `code` on DOMExceptions and inside the message on IPC rejections. */
      const isAborted = (error) => error?.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(String(error?.message ?? error));

      /** Acquire the lease and attach the guest if not alive; resolves once the first document is ready. */
      async function ensure() {
        if (state.view) return state.view;
        if (!bridge) throw new Error('desktop bridge unavailable');
        if (state.opening) return state.opening;
        state.opening = (async () => {
          const reservation = await bridge.acquire('dsh-plugin-boss');
          const view = document.createElement('webview');
          // Attribute set mirrors ElectronWebviewPresentation: will-attach in
          // the main process reads the lease from src and requires the exact
          // partition; name carries the lease for post-attach identification.
          view.setAttribute('name', reservation.lease);
          view.setAttribute('partition', reservation.partition);
          view.setAttribute('allowpopups', '');
          view.setAttribute('src', 'about:blank#' + reservation.lease);
          const body = ensureDom().querySelector('.dsh-boss-float-body');
          body.textContent = '';
          body.appendChild(view);
          state.view = view;
          state.lease = reservation.lease;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('webview attach timeout')), 15_000);
            view.addEventListener('dom-ready', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          // The lease-bearing bootstrap document is not a user history entry.
          try { view.clearHistory(); } catch { /* best effort */ }
          view.addEventListener('did-fail-load', (event) => {
            if (event.isMainFrame === false || event.errorCode === -3) return;
            notify(`${t('webviewError')}${event.errorCode} ${event.errorDescription ?? ''}`.trim(), false);
          });
          await view.loadURL(LOGIN_URL).catch((error) => {
            if (!isAborted(error)) throw error;
          });
          state.keepAlive = setInterval(() => { void refreshStoken(); }, STOKEN_REFRESH_MS);
          return view;
        })();
        try {
          return await state.opening;
        } finally {
          state.opening = null;
        }
      }

      /** Read cookies from the partition via the shell bridge (HttpOnly included); falls back to document.cookie on older shells. */
      async function readCookies() {
        if (!state.view || !state.lease) throw new Error('webview not ready');
        if (typeof bridge.getCookies === 'function') {
          const cookies = await bridge.getCookies(state.lease, COOKIE_DOMAIN);
          return {
            header: cookies.map((pair) => `${pair.name}=${pair.value}`).join('; '),
            names: cookies.map((pair) => pair.name),
          };
        }
        const header = await state.view.executeJavaScript('document.cookie', false);
        return { header, names: header ? header.split(';').map((part) => part.split('=')[0].trim()) : [] };
      }

      /** Push the current partition cookies into the host session store. */
      async function harvest() {
        const { header, names } = await readCookies();
        if (!header) throw new Error('no cookies in partition');
        const response = await fetch('/boss-plugin/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cookies: header, source: 'webview' }),
        });
        const result = await response.json();
        changed();
        return { complete: result.complete === true, names };
      }

      /**
       * Pop the window out. `login` watches for the session to appear and
       * hides itself after harvesting; `browse` just shows the page.
       * @param {'login' | 'browse'} mode
       */
      async function show(mode) {
        if (!bridge) return;
        ensureDom().hidden = false;
        state.mode = mode;
        setStatusText(mode === 'login' ? t('floatWaitingLogin') : t('floatBrowse'));
        await ensure();
        if (mode === 'login') startLoginWatch();
      }

      function hide() {
        if (root) root.hidden = true;
        state.mode = null;
        stopLoginWatch();
      }

      function startLoginWatch() {
        stopLoginWatch();
        state.loginTimer = setInterval(async () => {
          try {
            const { names } = await readCookies();
            if (names.includes('wt2') && names.includes('__zp_stoken__')) {
              stopLoginWatch();
              await harvest();
              hide();
              notify(t('webviewHarvestOk'), true);
            }
          } catch { /* keep waiting */ }
        }, LOGIN_POLL_MS);
      }

      function stopLoginWatch() {
        if (state.loginTimer) { clearInterval(state.loginTimer); state.loginTimer = null; }
      }

      /** Reload the page so zhipin's JS recomputes __zp_stoken__, then harvest. */
      async function refreshStoken() {
        if (state.refreshing || !state.view) return;
        state.refreshing = true;
        try {
          const view = state.view;
          await new Promise((resolve) => {
            const done = () => { view.removeEventListener('dom-ready', done); resolve(); };
            view.addEventListener('dom-ready', done);
            view.reload();
          });
          // Give the page scripts a beat to settle the token cookie.
          await new Promise((r) => setTimeout(r, 1500));
          await harvest();
        } catch (error) {
          notify(`${t('webviewHarvestFail')}：${String(error?.message ?? error)}`, false);
        } finally {
          state.refreshing = false;
        }
      }

      async function destroy() {
        stopLoginWatch();
        if (state.keepAlive) { clearInterval(state.keepAlive); state.keepAlive = null; }
        const lease = state.lease;
        state.view = null;
        state.lease = null;
        if (root && root.parentNode) root.parentNode.removeChild(root);
        root = null;
        if (lease) {
          try { await bridge?.release?.(lease); } catch { /* already gone */ }
        }
      }

      return api;
    }

    // ============================================================== page

    function BossPage(props) {
      const host = props?.bossHost;
      const [status, setStatus] = React.useState(null);
      const [cookieText, setCookieText] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [webNotice, setWebNotice] = React.useState(null);

      const refresh = React.useCallback(async () => {
        try {
          const response = await fetch('/boss-plugin/status', { cache: 'no-store' });
          setStatus(await response.json());
        } catch (error) {
          setStatus({ session: { loggedIn: false }, error: String(error) });
        }
        // Surface webview-host notices (login captured, rotation failures).
        setWebNotice(host?.lastNotice ? { ...host.lastNotice } : null);
      }, [host]);

      React.useEffect(() => {
        ensureStyles();
        void refresh();
        const timer = setInterval(() => void refresh(), STATUS_POLL_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      // Host flagged the anti-crawler token stale → rotate immediately.
      React.useEffect(() => {
        if (status?.session?.stokenStale && host?.available) void host.refreshStoken();
      }, [status?.session?.stokenStale, host]);

      async function doImport() {
        if (cookieText.trim() === '') return;
        setBusy(true);
        setMessage(null);
        try {
          const response = await fetch('/boss-plugin/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cookies: cookieText.trim(), source: 'manual' }),
          });
          const result = await response.json();
          if (result.imported && result.complete) setMessage({ ok: true, text: t('importOk') });
          else if (result.imported) setMessage({ ok: false, text: `${t('importPartial')} ${(result.missing ?? []).join(', ')}` });
          else setMessage({ ok: false, text: `${t('importFail')}：${result.message ?? ''}` });
          setCookieText('');
          void refresh();
        } catch (error) {
          setMessage({ ok: false, text: `${t('importFail')}：${String(error)}` });
        } finally {
          setBusy(false);
        }
      }

      const session = status?.session ?? {};
      const count = Number(session.count ?? 0);
      return h('div', { className: 'dsh-boss-page' },
        h('h2', null, t('page')),
        h('div', { className: 'dsh-boss-subtitle' }, t('subtitle')),
        status?.riskLock && h('div', { className: 'dsh-boss-msg bad' }, t('riskLock')),
        session.stokenStale && h('div', { className: 'dsh-boss-msg hint' }, t('stokenRefreshing')),
        h('div', { className: 'dsh-boss-cols' },
          h('div', { className: 'dsh-boss-card' },
            h('h4', null, t('page')),
            status === null
              ? h('div', { className: 'dsh-boss-kv' }, t('loading'))
              : h('div', { className: 'dsh-boss-row' },
                session.loggedIn
                  ? h('span', { className: 'dsh-boss-badge ok' }, t('loggedIn'))
                  : count > 0
                    ? h('span', { className: 'dsh-boss-badge warn' }, t('partial'))
                    : h('span', { className: 'dsh-boss-badge bad' }, t('loggedOut')),
                count > 0 && h('span', { className: 'dsh-boss-kv' }, `${t('collected')} ${count} ${t('cookiesUnit')}`),
                session.source && h('span', { className: 'dsh-boss-kv' }, `${t('source')}: ${session.source}`),
                session.age && h('span', { className: 'dsh-boss-kv' }, `${t('savedAt')}: ${session.age}`),
                h('button', { className: 'dsh-boss-button', onClick: () => void refresh() }, t('refresh')),
              ),
            Array.isArray(session.missing) && session.missing.length > 0
              && h('div', { className: 'dsh-boss-msg bad' },
                `${t('missing')}: ${session.missing.join(', ')}`,
                session.missing.includes('wt2') && h('div', { className: 'dsh-boss-msg hint', style: { marginTop: 4 } }, t('httponlyHint')),
              ),
            h('div', { className: 'dsh-boss-card', style: { border: 'none', padding: 0 } },
              h('h4', null, t('importTitle')),
              h('div', { className: 'dsh-boss-kv' }, t('importHint')),
              h('textarea', {
                className: 'dsh-boss-textarea',
                placeholder: t('placeholder'),
                value: cookieText,
                onChange: (event) => setCookieText(event.target.value),
                spellCheck: false,
              }),
              h('div', { className: 'dsh-boss-row' },
                h('button', { className: 'dsh-boss-button primary', disabled: busy || cookieText.trim() === '', onClick: doImport }, busy ? t('importing') : t('importButton')),
              ),
              message && h('div', { className: `dsh-boss-msg ${message.ok ? 'ok' : 'bad'}` }, message.text),
            ),
          ),
          h('div', { className: 'dsh-boss-card' },
            h('h4', null, t('webviewTitle')),
            host?.available
              ? h('div', { className: 'dsh-boss-kv' }, t('webviewHintDesktop'))
              : h('div', { className: 'dsh-boss-kv', style: { opacity: .7 } }, t('webviewUnsupported')),
            host?.available && h('div', { className: 'dsh-boss-row' },
              !session.loggedIn && h('button', { className: 'dsh-boss-button primary', onClick: () => void host.show('login') }, t('login')),
              h('button', { className: 'dsh-boss-button', onClick: () => void host.show('browse') }, t('browse')),
              h('button', { className: 'dsh-boss-button', onClick: () => host.hide() }, t('hideWindow')),
            ),
            webNotice && h('div', { className: `dsh-boss-msg ${webNotice.ok ? 'ok' : 'bad'}` }, webNotice.text),
          ),
        ),
      );
    }

    // ============================================================== icon

    /** Sidebar launcher icon; props follow SidebarPanelIconOwnerProps. */
    function BossPanelIcon({ size = 20, active }) {
      const color = active ? 'var(--dsw-accent, #007aff)' : 'currentColor';
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M4 5h16v11H8.5L4 19.5V5z', stroke: color, strokeWidth: '1.6', strokeLinejoin: 'round' }),
        h('circle', { cx: '9', cy: '10.5', r: '1.3', fill: color }),
        h('circle', { cx: '12.5', cy: '10.5', r: '1.3', fill: color }),
        h('circle', { cx: '16', cy: '10.5', r: '1.3', fill: color }),
      );
    }

    // ============================================================== apply

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ensureStyles();
        } catch { /* cosmetic */ }
        try {
          ctx.locale.register(NS, { zh, en });
          const bound = ctx.locale.bind?.(NS);
          if (typeof bound === 'function') translate = bound;
        } catch { /* older cores keep bundled dict */ }

        // Persistent webview host; notices surface on the page via the
        // status poll picking up host.lastNotice.
        const webviewHost = createWebviewHost({});

        // Main page: keyed occupant of the central panel, id 'boss'.
        try {
          const registerMain = () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          }, (props) => h(BossPage, { ...props, bossHost: webviewHost }));
          ctx.effect(() => ctx.slots.inject('main', registerMain), 'dsh-plugin-boss: main page');
        } catch (error) {
          console.warn('dsh-plugin-boss: main panel unavailable', error);
        }

        // Left-sidebar launcher row addressing that panel.
        try {
          const registerEntry = () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 60,
            label: () => t('panel'),
            locale: NS,
          }, BossPanelIcon);
          ctx.effect(() => ctx.slots.inject('sidebar.panellist', registerEntry), 'dsh-plugin-boss: sidebar entry');
        } catch (error) {
          console.warn('dsh-plugin-boss: sidebar entry unavailable', error);
        }

        ctx.effect(() => () => { void webviewHost.destroy(); }, 'dsh-plugin-boss: webview host');
      },
    };
  },
});

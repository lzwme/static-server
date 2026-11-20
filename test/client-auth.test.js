/**
 * 客户端的认证失效处理
 *
 * 这是「狂刷接口」这个缺陷的回归测试：
 * 接口返回 401 之后，客户端必须把它当成异常终止——
 * 清掉死会话、断开事件流、停掉后台定时器、并在本地短路后续请求，
 * 而不是继续往下发请求、再拿一堆 401、再把频率限制打满。
 *
 * 用 vm 载入前端脚本，配一套最小化的假 DOM 与假 fetch，
 * 直接观察「发了哪些请求」与「弹了哪个框」。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const APP_JS = path.join(__dirname, '..', 'dist', 'localsend', 'client', 'app.js');

/** 假 DOM 元素：够用即可，重点是能记录事件监听与 class 变化 */
function createEl(id) {
  const classes = new Set();
  const el = {
    id,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        } else if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    listeners: {},
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    checked: false,
    selected: false,
    files: [],
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    dispatch(type, event) {
      const evt = event || { target: this, preventDefault() {}, stopPropagation() {} };
      (this.listeners[type] || []).forEach((fn) => fn(evt));
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      return child;
    },
    insertBefore(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren() {
      this.children = [];
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    getAttribute(key) {
      return key in this.attributes ? this.attributes[key] : null;
    },
    removeAttribute(key) {
      delete this.attributes[key];
    },
    hasAttribute(key) {
      return key in this.attributes;
    },
    focus() {},
    blur() {},
    select() {},
    click() {
      this.dispatch('click');
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    contains() {
      return false;
    },
    remove() {},
    scrollIntoView() {},
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
    },
    getContext() {
      return null;
    },
  };
  return el;
}

/** 构造一个假响应对象 */
function makeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone() {
      return makeResponse(status, body);
    },
  };
}

/**
 * 载入前端脚本，返回沙箱句柄。
 *
 * sessionData 是 /api/session 的返回内容，apiStatus 是其它接口的状态码。
 */
function loadApp({
  sessionData,
  apiStatus = 401,
  apiBody = { code: 1, msg: '会话已失效，请重新登录', needLogin: true },
  loginResult,
} = {}) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, createEl(id));
    return elements.get(id);
  };
  const storage = new Map();
  const calls = [];
  const requests = [];
  const listeners = [];

  const fetchStub = (url, init) => {
    const target = String(url);
    calls.push(target);
    requests.push({ url: target, body: init && init.body ? String(init.body) : '' });
    if (target.indexOf('/api/session') >= 0) {
      return Promise.resolve(makeResponse(200, { code: 0, data: sessionData }));
    }
    // 候选地址与盐值：登录流程需要，默认给一份三种凭据齐全的盐值
    if (target.indexOf('/api/network') >= 0) {
      return Promise.resolve(makeResponse(200, { code: 0, data: { addresses: [], suggested: '', connected: '', loopback: true } }));
    }
    if (target.indexOf('/api/auth/salt') >= 0) {
      // 服务端只公布「已配置」的密钥盐值：这里跟着 session 的配置走
      const info = sessionData || {};
      const secrets = [];
      if (info.hasAdmin !== false) secrets.push({ kind: 'password', salt: 'aa', iterations: 1000 });
      if (info.hasVisitor) secrets.push({ kind: 'visitorPassword', salt: 'bb', iterations: 1000 });
      if (info.hasToken !== false) secrets.push({ kind: 'token', salt: 'cc', iterations: 1000 });
      return Promise.resolve(makeResponse(200, { code: 0, data: { iterations: 1000, secrets } }));
    }
    if (loginResult && target.indexOf('/api/auth/login') >= 0) {
      return Promise.resolve(makeResponse(200, loginResult));
    }
    return Promise.resolve(makeResponse(apiStatus, apiBody));
  };

  const documentStub = {
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => createEl('created-' + tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener() {},
    body: createEl('body'),
    documentElement: createEl('html'),
  };

  const sandbox = {
    console,
    Promise,
    Object,
    Array,
    JSON,
    String,
    Number,
    Boolean,
    Date,
    Math,
    Error,
    RegExp,
    Map,
    Set,
    encodeURIComponent,
    decodeURIComponent,
    URLSearchParams,
    URL,
    Blob,
    FormData,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchStub,
    document: documentStub,
    navigator: { userAgent: 'node-test' },
    location: { origin: 'http://127.0.0.1:8779', pathname: '/localsend', href: 'http://127.0.0.1:8779/localsend' },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear(),
    },
    window: {
      addEventListener: (type, fn) => listeners.push([type, fn]),
      removeEventListener() {},
      confirm: () => true,
      isSecureContext: false,
      location: { origin: 'http://127.0.0.1:8779', pathname: '/localsend' },
      // 前端用它在浏览器里派生摘要；测试里只要保证「按 kind 生成不同摘要」即可
      LocalsendCrypto: {
        pbkdf2Hex: (secret, salt, iterations) => `digest:${salt}:${iterations}:${secret}`,
      },
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;

  const code = fs.readFileSync(APP_JS, 'utf8');
  // 真实页面里这些弹窗默认是隐藏的，假 DOM 也要保持一致，
  // 否则「弹窗是否可见」的判断会失真
  for (const id of ['qrModal', 'previewModal', 'trashModal', 'renameModal', 'moveModal', 'batchRenameModal', 'loginModal', 'textModal', 'settingsModal', 'shareModal']) {
    getEl(id).classList.add('hidden');
  }
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });

  return {
    el: getEl,
    calls,
    requests,
    storage,
    /** 等待若干轮微任务与定时器 */
    async settle(ms = 60) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

/** 打开模态框的判断依据：classList 里没有 hidden 即为可见 */
function visible(el) {
  return el && !el.classList.contains('hidden');
}

describe('客户端把 401 当作异常终止', () => {
  it('会话失效后不再继续发请求，并弹出重新登录框', async () => {
    const app = loadApp({
      sessionData: { role: 'admin', open: false, hasAdmin: true, hasVisitor: false, hasToken: true, sessionValid: true, expiresAt: Date.now() + 3600000 },
    });
    await app.settle();

    // 启动时先探一次身份，随后各接口陆续拿到 401
    assert.ok(app.calls.length >= 1, '启动时应该发过请求');
    assert.ok(app.calls.some((url) => url.indexOf('/api/session') >= 0));

    // 口令登录的身份失效：应该弹登录框，而不是令牌框
    assert.equal(visible(app.el('loginModal')), true, '应该弹出登录框');

    // 关键：请求数不再增长
    const settled = app.calls.length;
    await app.settle(120);
    assert.equal(app.calls.length, settled, '认证失效后不应该继续发请求');
  });

  it('认证失效后手动触发接口也不会再发往服务端', async () => {
    const app = loadApp({
      sessionData: { role: 'admin', open: false, hasAdmin: true, hasVisitor: false, hasToken: true, sessionValid: true, expiresAt: Date.now() + 3600000 },
    });
    await app.settle();
    const settled = app.calls.length;

    // 回收站按钮会走一次接口调用
    app.el('trashBtn').dispatch('click');
    await app.settle(120);

    assert.equal(app.calls.length, settled, '认证失效后的请求应该被本地拦下');
  });

  it('失效的会话会从本地清掉', async () => {
    const app = loadApp({
      sessionData: { role: 'admin', open: false, hasAdmin: true, hasVisitor: false, hasToken: true, sessionValid: true, expiresAt: Date.now() + 3600000 },
    });
    // 模拟浏览器里存着旧会话
    app.storage.set('localsend.session', 'stale-session');
    await app.settle();
    assert.equal(app.storage.get('localsend.session'), undefined, '死会话应该被清掉');
  });

  it('令牌用户失效时弹统一的认证框', async () => {
    const app = loadApp({
      sessionData: { role: 'guest', open: false, hasAdmin: false, hasVisitor: false, hasToken: true, sessionValid: true, expiresAt: Date.now() + 3600000 },
      apiBody: { code: 1, msg: '会话已失效，请重新登录', needLogin: true },
    });
    app.storage.set('localsend.authMethod', 'token');
    await app.settle();
    // 口令与令牌共用一个输入框：不再区分「令牌框 / 登录框」
    assert.equal(visible(app.el('loginModal')), true, '应该弹出认证框');
    assert.match(app.el('loginHint').textContent, /访问令牌/);
  });

  it('缺令牌（从未登录）时弹的也是统一认证框', async () => {
    const app = loadApp({
      sessionData: { role: 'guest', open: false, hasAdmin: false, hasVisitor: false, hasToken: true, sessionValid: true, expiresAt: Date.now() + 3600000 },
      apiBody: { code: 1, msg: '需要访问令牌', needToken: true },
    });
    await app.settle();
    assert.equal(visible(app.el('loginModal')), true, '应该弹出认证框');
    assert.match(app.el('loginHint').textContent, /访问令牌/);
  });
});

describe('统一登录入口', () => {
  it('一个输入框同时提交口令与令牌摘要，并按返回的身份落地', async () => {
    const app = loadApp({
      sessionData: { role: 'guest', open: false, hasAdmin: true, hasVisitor: false, hasToken: true, sessionValid: true, expiresAt: Date.now() + 3600000 },
      apiStatus: 200,
      apiBody: { code: 0, data: { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1, allTotal: 0 } },
      loginResult: { code: 0, data: { token: 'sess-1', role: 'admin', via: 'password', expiresAt: Date.now() + 3600000 } },
    });
    await app.settle();

    // 主动打开登录框：提示里应把服务端配置的可用凭据都列出来
    app.el('loginBtn').dispatch('click');
    assert.equal(visible(app.el('loginModal')), true, '应该打开认证框');
    assert.match(app.el('loginHint').textContent, /管理员口令/);
    assert.match(app.el('loginHint').textContent, /访问令牌/);

    app.el('loginPassword').value = 'my-secret';
    app.el('loginOk').dispatch('click');
    await app.settle(150);

    const login = app.requests.find((item) => item.url.indexOf('/api/auth/login') >= 0);
    assert.ok(login, '应该提交登录请求');
    const digests = JSON.parse(login.body).digests;
    assert.ok(digests.password, '应提交管理员口令摘要');
    assert.ok(digests.token, '应同时提交令牌摘要');
    assert.equal(digests.visitorPassword, undefined, '未配置访客口令时不该提交它');
    assert.equal(app.storage.get('localsend.session'), 'sess-1', '应保存服务端签发的会话');
    assert.equal(visible(app.el('loginModal')), false, '成功后应关闭弹窗');
  });
});

describe('需要令牌时的整页遮罩', () => {
  const unverified = { role: 'guest', open: false, hasAdmin: false, hasVisitor: false, hasToken: true, sessionValid: false, expiresAt: 0 };

  it('未验证时遮住整页，并收起「取消」按钮', async () => {
    const app = loadApp({ sessionData: unverified });
    await app.settle();
    assert.equal(visible(app.el('authGate')), true, '应遮住整页');
    assert.equal(visible(app.el('loginCancel')), false, '此时取消等于把自己关在门外');
    assert.equal(app.el('roleBadge').textContent, '未验证');
    // 遮罩上留了入口，点它打开认证框
    app.el('authGateBtn').dispatch('click');
    assert.equal(visible(app.el('loginModal')), true);
    // 提示文案不能再出现「开放模式，无需登录」这种自相矛盾的说法
    assert.doesNotMatch(app.el('loginHint').textContent, /开放模式/);
    assert.match(app.el('loginHint').textContent, /访问令牌/);
  });

  it('令牌验证通过后恢复整页', async () => {
    const app = loadApp({
      sessionData: { ...unverified, role: 'open', sessionValid: true, expiresAt: Date.now() + 3600000 },
      apiStatus: 200,
      apiBody: { code: 0, data: { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1, allTotal: 0 } },
    });
    await app.settle();
    assert.equal(visible(app.el('authGate')), false);
    assert.equal(visible(app.el('loginCancel')), true);
    assert.equal(app.el('roleBadge').textContent, '管理员（令牌）');
  });

  it('只配口令、没配令牌时不做遮罩，保留只读浏览', async () => {
    const app = loadApp({ sessionData: { role: 'guest', open: false, hasAdmin: true, hasVisitor: false, hasToken: false, sessionValid: false, expiresAt: 0 } });
    await app.settle();
    assert.equal(visible(app.el('authGate')), false);
    assert.equal(visible(app.el('loginCancel')), true);
  });
});

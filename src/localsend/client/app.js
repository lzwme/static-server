(function () {
  'use strict';
  var API = '/localsend/api';
  var $ = function (id) { return document.getElementById(id); };
  /**
   * 会话令牌只放在请求头里。
   *
   * 下载、预览、打包、事件流这几类请求由 <img> / <a> / EventSource 发起，
   * 带不了自定义请求头；以前是把会话拼进 URL（?session=），
   * 结果「复制链接」等于把自己的会话发出去，URL 还会留在历史与日志里。
   * 现在改为「先换一张短期票据，再用票据访问」，见下面的 issueTicket。
   *
   * 服务端配置了口令时，危险操作（删除、整理、撤销分享）需要管理员身份；
   * 上传与分享需要访客以上身份，但没有配置访客口令时任何人都可以上传下载。
   * 口令与访问令牌都不以明文提交：客户端用服务端公开的盐值派生出摘要，
   * 服务端只比对摘要（见 crypto.js 与服务端的 secret.ts）。
   * 会话令牌存在 localStorage，由服务端内存维护，服务重启后失效，需要重新登录。
   */
  var SESSION_STORAGE_KEY = 'localsend.session';
  var TOKEN_STORAGE_KEY = 'localsend.token';
  /** 登录方式：password（口令）/ token（访问令牌）。会话失效时据此提示正确的重新认证入口 */
  var AUTH_METHOD_STORAGE_KEY = 'localsend.authMethod';
  var sessionToken = '';
  // 用户输入的访问令牌：只留在浏览器里，用于向服务端换取会话
  var accessToken = '';
  /** 令牌自动校验进行中：避免多个 401 同时触发重复校验 */
  var tokenExchangePending = false;
  /** 本次页面生命周期内是否已经自动试过保存的令牌 */
  var tokenAutoTried = false;
  /**
   * 认证失效：接口返回 401 之后置位。
   *
   * 未授权不是普通错误，它意味着后面的每个请求都会失败。
   * 置位之后所有请求在本地就被拦下，不再发往服务端，
   * 从根上杜绝「继续请求 → 继续 401 → 打满频率限制」的死循环。
   * 重新认证成功、拿到新会话后自动解除。
   */
  var authBlocked = false;
  /** 上次探测事件流连接状态的时间戳（毫秒），用来限制探测频率 */
  var sseProbeAt = 0;
  /** 本次登录使用的凭据类型 */
  var authMethod = '';
  try {
    sessionToken = localStorage.getItem(SESSION_STORAGE_KEY) || '';
    accessToken = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    authMethod = localStorage.getItem(AUTH_METHOD_STORAGE_KEY) || '';
  } catch (e) {
    // localStorage 不可用时忽略
  }
  // 当前身份：role 为 admin / visitor / guest / open
  var sessionInfo = { role: 'open', open: true, hasAdmin: false, hasVisitor: false };

  /** 是否可以执行危险操作（删除、整理目录、撤销分享等） */
  function isAdmin() {
    return sessionInfo.role === 'admin' || sessionInfo.role === 'open';
  }
  /** 是否可以写入（上传、粘贴、创建分享等） */
  function canWrite() {
    if (sessionInfo.role !== 'guest') return true;
    // 未登录（只读）身份能否上传，取决于服务端是否配置了访客口令：
    // 没有访客口令时允许任何人上传下载；配置了则必须先输入口令登录
    return !sessionInfo.hasVisitor;
  }
  /**
   * 带会话头的底层请求：只负责把会话令牌放进请求头，不进 URL。
   * 不做任何认证失败处理，由调用方决定怎么处理。
   */
  function sessionFetch(url, init) {
    var opts = init || {};
    var headers = opts.headers || {};
    if (sessionToken) headers['X-Localsend-Session'] = sessionToken;
    opts.headers = headers;
    return fetch(url, opts);
  }

  /** 构造认证失败错误：统一流程已经处理过，调用方只需要终止当前流水线 */
  function authError(msg) {
    var err = new Error(msg || '需要重新认证');
    err.authFailed = true;
    return err;
  }

  /** 清掉本地会话（会话失效或退出登录时用） */
  function clearSession() {
    sessionToken = '';
    try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch (e) { /* 忽略存储失败 */ }
  }

  /** 记录本次使用的凭据类型：会话失效时据此提示正确的重新认证入口 */
  function setAuthMethod(method) {
    authMethod = method || '';
    try {
      if (authMethod) localStorage.setItem(AUTH_METHOD_STORAGE_KEY, authMethod);
      else localStorage.removeItem(AUTH_METHOD_STORAGE_KEY);
    } catch (e) { /* 忽略存储失败 */ }
  }

  /**
   * 认证失效的统一处理。
   *
   * 未授权不是普通错误：它意味着后面的每个请求都会失败。
   * 所以这里把整条流水线停掉——清掉死会话、断开事件流、停掉后台定时器、
   * 置上短路开关——再弹出对应的重新认证入口，绝不自动重试。
   *
   * 弹哪个框取决于客户端是怎么进来的：
   *  - 用口令登录的：口令变了或会话过期了，要重新输口令
   *  - 用访问令牌进来的：令牌变了或会话过期了，要重新输令牌
   */
  function handleAuthFailure(json) {
    var first = !authBlocked;
    // 短路：后续请求在本地就被拦下，不再发往服务端
    authBlocked = true;
    // 死会话不能再带着走
    clearSession();
    // 事件流会自动重连，不断开就是持续的无效请求
    closeEvents();
    // 后台定时器同理：监听目录每 3 秒发一次请求
    var watching = !!watchHandle;
    stopWatchDir();
    // 身份回到未登录，界面要如实反映，不能继续显示旧角色
    sessionInfo.role = sessionInfo.open ? 'open' : 'guest';
    applyRole();
    if (watching) toast('会话已失效，目录监听已停止');
    // 已经在重新认证流程里了，不再重复弹窗
    if (!first) return;
    var msg = (json && json.msg) || '';
    // 之前用访问令牌进来的：先拿保存的令牌自动换一次，失败再让用户输入
    if (authMethod === 'token' && accessToken && !tokenAutoTried && !tokenExchangePending) {
      tokenAutoTried = true;
      tokenExchangePending = true;
      exchangeToken(accessToken)
        .then(function () {
          refreshSession().then(function (ok) {
            if (ok) startApp();
          });
        })
        .catch(function () {
          openLoginModal(msg || '会话已失效，请重新验证');
        })
        .then(function () {
          tokenExchangePending = false;
        });
      return;
    }
    openLoginModal(msg || '会话已失效，请重新验证');
  }

  /**
   * 统一的接口请求：自动带上会话令牌（放在请求头里，不进 URL）。
   *
   * 401（未授权）是异常状态，不是普通响应：
   * 走统一处理链（清会话、断事件流、停后台定时器、提示重新认证）之后
   * 直接抛错终止本次流水线，绝不让它继续往下跑。
   * 权限不足（403）时弹出登录框；其它 403（如禁止上传的类型）不打扰用户。
   */
  function apiFetch(url, init) {
    // 认证失效后不再发请求：继续发只会全部 401，把频率限制打满
    if (authBlocked) return Promise.reject(authError('需要重新认证'));
    return sessionFetch(url, init).then(function (r) {
      if (r.status === 401) {
        return r
          .clone()
          .json()
          .catch(function () { return null; })
          .then(function (json) {
            handleAuthFailure(json);
            throw authError((json && json.msg) || '需要重新认证');
          });
      }
      // 权限不足时引导登录；其它 403（如禁止上传的类型）不打扰用户
      if (r.status === 403) {
        r.clone()
          .json()
          .then(function (json) {
            if (json && json.needAuth) {
              // 服务端认为身份不够，说明当前身份已经变了：界面要跟着变，
              // 不能继续显示旧角色，免得用户一直点着注定失败的按钮
              sessionInfo.role = 'guest';
              applyRole();
              openLoginModal(json.msg);
            }
          })
          .catch(function () {});
      }
      return r;
    });
  }

  // ---------------------------------------------------------------------------
  // 短期访问票据
  //
  // 下载 / 预览 / 打包 / 事件流的 URL 由浏览器标签直接发起，带不了请求头。
  // 用票据替代「把会话拼进 URL」：票据只对指定文件有效、几分钟过期，
  // 即使被复制出去，影响面也远小于会话令牌。
  // ---------------------------------------------------------------------------

  /** 换一张票据 */
  function issueTicket(scope, names) {
    return apiFetch(API + '/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: scope, names: names || [] }),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) throw new Error(json.msg || '获取访问票据失败');
        return json.data;
      });
  }

  /** 生成带票据的 URL：path 为票据令牌之后的路径片段 */
  function ticketUrl(scope, names, path) {
    return issueTicket(scope, names).then(function (data) {
      return location.origin + API + '/t/' + encodeURIComponent(data.token) + path;
    });
  }

  /** 下载地址（票据版） */
  function downloadUrl(name) {
    return ticketUrl('download', [name], '/download/' + encodeURIComponent(name));
  }

  /** 预览地址（票据版） */
  function previewUrl(name) {
    return ticketUrl('preview', [name], '/preview/' + encodeURIComponent(name));
  }

  /** 角色的中文名称 */
  function roleName(role) {
    if (role === 'admin') return '管理员';
    if (role === 'visitor') return '访客';
    if (role === 'guest') return '只读';
    return '开放';
  }

  /** 按当前身份刷新界面上的权限状态 */
  function applyRole() {
    var role = sessionInfo.role;
    var admin = isAdmin();
    var write = canWrite();
    var logged = role === 'admin' || role === 'visitor';

    // 身份徽章：让人一眼看出当前能做什么
    var badge = $('roleBadge');
    // 未登录时能否上传取决于是否配置了访客口令，徽章要如实反映
    var guestWrite = role === 'guest' && write;
    badge.textContent = sessionInfo.open ? '开放模式' : guestWrite ? '未登录·可上传' : roleName(role);
    if (sessionInfo.open) {
      badge.className = 'text-[11px] px-2 py-1 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300';
    } else if (role === 'admin') {
      badge.className = 'text-[11px] px-2 py-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
    } else if (role === 'visitor' || guestWrite) {
      badge.className = 'text-[11px] px-2 py-1 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-300';
    } else {
      badge.className = 'text-[11px] px-2 py-1 rounded-lg border border-slate-700 bg-slate-800/70 text-slate-400';
    }
    badge.classList.remove('hidden');

    // 登录与退出：开放模式无需登录
    $('loginBtn').style.display = logged || sessionInfo.open ? 'none' : '';
    $('logoutBtn').style.display = logged ? '' : 'none';

    // 按 data-need 标记控制各类操作入口
    var nodes = document.querySelectorAll('[data-need]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var need = el.getAttribute('data-need');
      var ok = need === 'admin' ? admin : write;
      // 用内联样式控制，避免与 hidden / sm:block 等类冲突
      el.style.display = ok ? '' : 'none';
    }
  }

  /**
   * 拉取当前身份。
   *
   * 返回 false 表示需要访问令牌（此时服务端返回 401），
   * 后续的数据加载与事件订阅都要等令牌验证通过再做。
   */
  function refreshSession() {
    // 这里用底层请求而不是 apiFetch：身份探测本身要能穿过「认证失效」的短路，
    // 否则就再也不知道服务端那边到底怎么了。
    return sessionFetch(API + '/session')
      .then(function (r) {
        if (r.status === 401) {
          // 会话失效：走统一处理（清会话、断事件流、停后台定时器、提示重新认证）
          return r
            .json()
            .catch(function () { return null; })
            .then(function (json) {
              handleAuthFailure(json);
              return null;
            });
        }
        return r.json();
      })
      .then(function (json) {
        if (!json) return false;
        if (json.code !== 0) return true;
        var prevRole = sessionInfo.role;
        sessionInfo = json.data || sessionInfo;
        // 会话已失效（超时、口令变更、服务重启）时清掉本地令牌，避免一直带着无效凭证。
        // 以服务端给出的 sessionValid 为准：用访问令牌换来的会话角色也是 guest，
        // 靠角色判断会把刚换到的会话误清掉。
        if (sessionInfo.sessionValid === false && sessionToken) {
          clearSession();
          // 之前是口令登录的：明确提示重新登录，别让界面继续假装已登录
          if (prevRole === 'admin' || prevRole === 'visitor') {
            openLoginModal('会话已失效，请重新登录');
          }
        }
        applyRole();
        return true;
      })
      .catch(function () {
        /* 拿不到身份信息时按默认权限显示 */
        return !authBlocked;
      });
  }

  /** 取回各密钥的公开盐值（客户端据此派生出摘要） */
  function fetchSalts() {
    return fetch(API + '/auth/salt')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) throw new Error(json.msg || '获取盐值失败');
        return json.data || {};
      });
  }

  /** 用公开盐值把口令/令牌派生成摘要 */
  function digestOf(salts, kind, secret) {
    var list = (salts && salts.secrets) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind === kind) {
        return window.LocalsendCrypto.pbkdf2Hex(secret, list[i].salt, list[i].iterations);
      }
    }
    return '';
  }

  /**
   * 保存服务端签发的会话令牌。
   *
   * method 记录这次是用口令还是访问令牌进来的：会话失效时据此提示正确的重新认证入口。
   */
  function applySession(data, method) {
    sessionToken = String((data && data.token) || '');
    try { localStorage.setItem(SESSION_STORAGE_KEY, sessionToken); } catch (e) { /* 忽略存储失败 */ }
    if (data && data.role) sessionInfo.role = data.role;
    if (method) setAuthMethod(method);
    // 拿到有效会话：解除短路，恢复正常请求
    authBlocked = false;
  }

  /** 当前可用的凭据类型，用于登录框提示（服务端已告知配置了哪几种） */
  function loginHintText() {
    if (sessionInfo.open) return '当前为开放模式，无需登录';
    var parts = [];
    if (sessionInfo.hasAdmin) parts.push('管理员口令');
    if (sessionInfo.hasVisitor) parts.push('访客口令');
    if (sessionInfo.hasToken) parts.push('访问令牌');
    if (!parts.length) return '请输入口令或访问令牌';
    return '请输入' + parts.join(' 或 ');
  }

  /** 打开登录弹窗（口令与访问令牌共用一个入口） */
  function openLoginModal(msg) {
    var err = $('loginError');
    if (msg) {
      err.textContent = msg;
      err.classList.remove('hidden');
    }
    $('loginHint').textContent = loginHintText();
    $('loginModal').classList.remove('hidden');
    setTimeout(function () { $('loginPassword').focus(); }, 60);
  }

  /** 关闭登录弹窗 */
  function closeLoginModal() {
    $('loginModal').classList.add('hidden');
    $('loginError').classList.add('hidden');
    $('loginPassword').value = '';
  }

  /**
   * 提交登录。
   *
   * 管理员口令、访客口令、访问令牌的摘要一起算、一起提交，
   * 由服务端判断用户手里拿的是哪一种。
   * 这样前端只需要一个输入框，用户不必先分辨「我该输哪一个」。
   * 明文凭据始终留在浏览器里，网络上只有摘要。
   */
  function submitLogin() {
    var input = $('loginPassword');
    var secret = input.value;
    var err = $('loginError');
    if (!secret) {
      err.textContent = '请输入口令或访问令牌';
      err.classList.remove('hidden');
      return;
    }
    $('loginOk').disabled = true;
    fetchSalts()
      .then(function (salts) {
        var digests = {};
        var admin = digestOf(salts, 'password', secret);
        var visitor = digestOf(salts, 'visitorPassword', secret);
        var token = digestOf(salts, 'token', secret);
        if (admin) digests.password = admin;
        if (visitor) digests.visitorPassword = visitor;
        if (token) digests.token = token;
        if (!admin && !visitor && !token) throw new Error('服务端未启用口令或令牌验证');
        return fetch(API + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ digests: digests }),
        });
      })
      .then(function (r) {
        return r.json().then(function (json) {
          return { status: r.status, json: json };
        });
      })
      .then(function (out) {
        if (out.status !== 200 || out.json.code !== 0) {
          err.textContent = out.json.msg || '口令或访问令牌不正确';
          err.classList.remove('hidden');
          input.select();
          return;
        }
        var data = out.json.data || {};
        applySession(data, data.via === 'token' ? 'token' : 'password');
        // 用访问令牌进来的：记住它，会话过期时可以自动换一次，不必让用户重敲
        if (data.via === 'token') {
          accessToken = secret;
          try {
            localStorage.setItem(TOKEN_STORAGE_KEY, secret);
          } catch (e) {
            /* 忽略存储失败 */
          }
        }
        input.value = '';
        err.classList.add('hidden');
        $('loginModal').classList.add('hidden');
        toast('已验证：' + roleName(data.role), 'ok');
        // 重新拉取身份并刷新列表，按新角色显示或隐藏操作入口
        refreshSession().then(function (ok) {
          if (ok) startApp();
        });
      })
      .catch(function (e) {
        err.textContent = (e && e.message) || '登录失败，请重试';
        err.classList.remove('hidden');
      })
      .then(function () { $('loginOk').disabled = false; });
  }

  /**
   * 用访问令牌换取会话（保留给「记住的令牌自动重连」与「改令牌后自动换会话」）。
   *
   * 令牌只在浏览器里派生成摘要，明文不会离开浏览器；
   * 服务端签发的会话令牌才是之后所有请求里出现的东西。
   */
  function exchangeToken(value) {
    return fetchSalts()
      .then(function (salts) {
        var digest = digestOf(salts, 'token', value);
        if (!digest) throw new Error('服务端未启用访问令牌');
        return fetch(API + '/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ digest: digest }),
        });
      })
      .then(function (r) {
        return r.json().then(function (json) {
          return { status: r.status, json: json };
        });
      })
      .then(function (out) {
        if (out.status !== 200 || out.json.code !== 0) throw new Error(out.json.msg || '访问令牌不正确');
        applySession(out.json.data, 'token');
        accessToken = value;
        try {
          localStorage.setItem(TOKEN_STORAGE_KEY, value);
        } catch (e) {
          /* 忽略存储失败 */
        }
        return out.json.data;
      });
  }

  /** 退出登录 */
  function logout() {
    apiFetch(API + '/logout', { method: 'POST' })
      .catch(function () { /* 退出失败也清理本地会话 */ })
      .then(function () {
        clearSession();
        setAuthMethod('');
        // 退出后回到访客身份，重新按访客口径加载
        authBlocked = false;
        sessionInfo.role = sessionInfo.open ? 'open' : 'guest';
        // 断开事件流：会话没了，重连只会不断拿到 401
        closeEvents();
        applyRole();
        loadFiles();
        toast('已退出登录', 'ok');
      });
  }
  // 访问地址里不再带令牌：访问令牌由用户在页面上输入，避免被网关日志留存
  var pageUrl = location.origin + location.pathname;

  /**
   * 更新当前展示的访问地址。
   *
   * 地址同时驱动三处：页面上的文本、标题气泡、以及二维码内容。
   * 多网卡机器上一个地址可能只有本机能打开，用户切换后二维码必须跟着变。
   */
  function setPageUrl(url) {
    if (!url) return;
    pageUrl = url;
    $('pageUrl').textContent = url;
    $('pageUrl').title = url;
    if (pageQrCode) pageQrCode.update({ data: url });
  }

  /**
   * 拉取候选访问地址，填充下拉框并选定默认值。
   *
   * 以前页面直接用 location.origin 生成二维码：从本机 localhost 打开时
   * 二维码里就是 localhost，手机扫了必然打不开；而服务端只给一个地址时
   * 又常常是 WSL / Docker 的网段。这里把「当前地址 + 全部候选网卡地址」
   * 合起来，能用当前地址就优先用它，否则用服务端建议的那个。
   */
  function loadNetworkInfo() {
    return fetch(API + '/network')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) return;
        var data = json.data || {};
        var list = data.addresses || [];
        var host = location.hostname;
        var isLoop = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
        var portPart = location.port ? ':' + location.port : '';
        var origin = location.protocol + '//';
        var candidates = [];
        // 当前地址对本机一定可达：不是回环就让它排第一，避免「本来能用却被换掉」
        if (!isLoop) candidates.push({ url: location.origin + location.pathname, label: host });
        list.forEach(function (item) {
          candidates.push({
            url: origin + item.address + portPart + '/localsend',
            label: item.address + (item.iface ? ' · ' + item.iface : ''),
          });
        });
        // 同一个地址可能出现两次（当前地址恰好也在候选列表里）
        var seen = {};
        candidates = candidates.filter(function (c) {
          if (seen[c.url]) return false;
          seen[c.url] = 1;
          return true;
        });
        if (!candidates.length) return;
        var preferred = candidates[0].url;
        if (isLoop && data.suggested) {
          for (var i = 0; i < candidates.length; i++) {
            if (candidates[i].url.indexOf('//' + data.suggested + portPart) >= 0) {
              preferred = candidates[i].url;
              break;
            }
          }
        }
        var sel = $('addrSelect');
        sel.innerHTML = candidates
          .map(function (c) {
            return '<option value="' + escapeHtml(c.url) + '"' + (c.url === preferred ? ' selected' : '') + '>' + escapeHtml(c.label) + '</option>';
          })
          .join('');
        sel.classList.toggle('hidden', candidates.length < 2);
        setPageUrl(preferred);
      })
      .catch(function () {
        /* 拿不到候选地址时保持当前地址，不影响使用 */
      });
  }

  $('addrSelect').addEventListener('change', function (e) { setPageUrl(e.target.value); });
  // 排序偏好记忆：记住用户上次选择的排序方式与升降序
  var sortType = 'time';
  var sortOrder = 'desc';
  try {
    var savedSort = JSON.parse(localStorage.getItem('localsend.sort') || 'null');
    if (savedSort && (savedSort.type === 'time' || savedSort.type === 'size')) {
      sortType = savedSort.type;
      if (savedSort.order === 'asc' || savedSort.order === 'desc') sortOrder = savedSort.order;
    }
  } catch (e) {
    // localStorage 不可用时忽略
  }
  function saveSortPref() {
    try {
      localStorage.setItem('localsend.sort', JSON.stringify({ type: sortType, order: sortOrder }));
    } catch (e) {
      // 忽略存储失败
    }
  }
  // 搜索关键词与分页状态
  //
  // 筛选条件（关键词、目录、扩展名、时间窗）全部下推到服务端，
  // 前端只拿到并渲染当前这一页，文件再多也不会把浏览器压垮。
  var searchKeyword = '';
  // 目录筛选：空字符串表示不过滤，'__root__' 表示只看根目录文件
  var dirFilter = '';
  /** 本次上传的目标目录（相对路径，空串表示根目录）：默认跟随当前筛选目录 */
  var uploadTargetDir = '';
  // 扩展名筛选：空字符串表示不过滤
  var extFilter = '';
  // 收件箱模式：只看最近收到的文件
  var inboxMode = false;
  var INBOX_WINDOW = 10 * 60 * 1000; // 收件箱时间窗口（10 分钟）
  var inboxNewCount = 0; // 进入收件箱后新收到的文件数
  var ownUploads = {}; // 本机刚上传的文件，避免自己提示自己
  var suppressNotifyUntil = 0; // 自己操作后的静默期，不提示「收到新文件」
  var eventSource = null; // 文件变更事件连接
  var PAGE_SIZE = 50; // 每页显示的文件数（服务端分页）
  var PAGE_SIZE_OPTIONS = [20, 50, 100, 200]; // 可选的每页条数
  var currentPage = 1;
  var totalPages = 1;
  var totalCount = 0; // 当前筛选条件下的文件总数
  var allCount = 0; // 全部文件数
  var modalQrCode = null;
  var selected = {};
  var fileItems = [];
  // 每页条数记忆：记住用户上次选择的分页大小
  try {
    var savedPageSize = Number(localStorage.getItem('localsend.pageSize') || 0);
    if (PAGE_SIZE_OPTIONS.indexOf(savedPageSize) >= 0) PAGE_SIZE = savedPageSize;
  } catch (e) {
    // localStorage 不可用时忽略
  }
  function savePageSizePref() {
    try {
      localStorage.setItem('localsend.pageSize', String(PAGE_SIZE));
    } catch (e) {
      // 忽略存储失败
    }
  }
  // 待高亮定位的文件名（上传成功后填充）
  var pendingHighlight = [];
  // 当前处于高亮状态的文件名
  var highlightNames = {};
  // 等待出现在列表中的新文件名
  var highlightQueue = [];
  // 高亮轮询定时器
  var highlightTimer = null;

  $('pageUrl').textContent = pageUrl;
  $('pageUrl').title = pageUrl;
  if (typeof QRCodeStyling !== 'undefined') {
    var pageQrCode = new QRCodeStyling({
      width: 220, height: 220, type: 'canvas', data: pageUrl, margin: 0,
      dotsOptions: { type: 'rounded', color: '#10b981' },
      backgroundOptions: { color: '#ffffff' },
      cornersSquareOptions: { type: 'extra-rounded', color: '#10b981' },
      cornersDotOptions: { type: 'dot', color: '#10b981' },
    });
    pageQrCode.append($('pageQr'));
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do { n /= 1024; i += 1; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(1) + ' ' + units[i];
  }
  function fmtTime(ms) {
    var d = new Date(ms);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg, type, action) {
    // 认证失效期间不弹错误提示：原因统一由重新认证弹窗说明，
    // 否则同一个原因会在各个接口的失败回调里反复刷屏
    if (authBlocked && type === 'err') return;
    var el = $('toast');
    el.textContent = '';
    el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] max-w-[92vw] rounded-xl px-4 sm:px-5 py-2.5 sm:py-3 text-xs sm:text-sm shadow-xl border border-white/10 flex items-center gap-3 ' + (type === 'ok' ? 'bg-emerald-600/90' : type === 'err' ? 'bg-red-600/90' : 'bg-slate-800/90');
    el.appendChild(document.createTextNode(msg));
    if (action) {
      var btn = document.createElement('button');
      btn.className = 'px-2 py-0.5 rounded border border-white/30 hover:bg-white/15 shrink-0 font-medium';
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        el.classList.add('hidden');
        action.onClick();
      });
      el.appendChild(btn);
    }
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.add('hidden'); }, action ? 6000 : 2600);
  }
  function copyText(text) {
    var done = function () { toast('已复制到剪贴板', 'ok'); };
    // 降级方案：部分环境（如页面未聚焦）不允许直接写剪贴板，改用临时文本域
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败', 'err'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(done).catch(fallback);
    }
    return fallback();
  }

  var iconMap = {
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', bmp: '🖼️', ico: '🖼️',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬', flv: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', m4a: '🎵', ogg: '🎵',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️', tgz: '🗜️',
    pdf: '📕', doc: '📘', docx: '📘', xls: '📊', xlsx: '📊', ppt: '📊', pptx: '📊', csv: '📊',
    txt: '📃', md: '📃', html: '🌐', htm: '🌐', js: '💻', ts: '💻', json: '🧩', css: '🎨', xml: '🧾', log: '📝'
  };
  function fileIcon(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    return iconMap[ext] || '📄';
  }

  // ---------------------------------------------------------------------------
  // 图片缩略图
  //
  // 直接用原图当列表图标会让图片多的目录加载非常吃力。这里在浏览器端把
  // 图片缩到很小尺寸后缓存起来：只在元素进入可视区域时才生成，
  // 生成结果存在内存里，列表重绘时直接复用。
  // ---------------------------------------------------------------------------
  var THUMB_MAX_SIZE = 2 * 1024 * 1024; // 超过 2MB 的图片不生成缩略图，避免整图传输
  var THUMB_EDGE = 96; // 缩略图最长边像素
  var thumbCache = {}; // 文件名 -> dataURL
  var thumbObserver = null;

  /** 是否是可以生成缩略图的位图格式（SVG 有外部引用风险，暂不处理） */
  function isThumbImage(name) {
    return /\.(jpg|jpeg|png|gif|webp|bmp|avif)$/i.test(name);
  }

  /** 生成缩略图并填入 img 元素 */
  function buildThumb(name, imgEl) {
    if (thumbCache[name]) {
      imgEl.src = thumbCache[name];
      imgEl.style.opacity = '1';
      return;
    }
    apiFetch(API + '/preview/' + encodeURIComponent(name))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        if (!window.createImageBitmap) throw new Error('不支持 createImageBitmap');
        return createImageBitmap(blob);
      })
      .then(function (bmp) {
        var scale = Math.min(THUMB_EDGE / bmp.width, THUMB_EDGE / bmp.height, 1);
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bmp.width * scale));
        canvas.height = Math.max(1, Math.round(bmp.height * scale));
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        if (bmp.close) bmp.close();
        var dataUrl = canvas.toDataURL('image/webp', 0.8);
        thumbCache[name] = dataUrl;
        imgEl.src = dataUrl;
        imgEl.style.opacity = '1';
      })
      .catch(function () {
        // 生成失败时保留原来的图标，不打扰用户
      });
  }

  /**
   * 监听缩略图占位元素，进入可视区域后再生成。
   *
   * 观察的是外层固定尺寸的容器，而不是 img 本身：
   * img 在生成前是透明的（而非 display:none），否则不会产生交叉事件。
   */
  function observeThumb(el) {
    var name = el.dataset.thumb;
    if (!name) return;
    var imgEl = el.querySelector('img');
    if (!imgEl) return;
    if (thumbCache[name]) {
      imgEl.src = thumbCache[name];
      imgEl.style.opacity = '1';
      return;
    }
    if (!thumbObserver) {
      thumbObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            thumbObserver.unobserve(entry.target);
            buildThumb(entry.target.dataset.thumb, entry.target.querySelector('img'));
          });
        },
        { rootMargin: '200px' }
      );
    }
    thumbObserver.observe(el);
  }
  function btn(label, act, danger, icon) {
    var cls = danger ? 'text-red-400 hover:bg-red-500/10 border-red-500/30' : 'text-slate-300 hover:bg-slate-700/70 border-slate-600/60';
    return '<button data-act="' + act + '" title="' + label + '" class="px-1.5 sm:px-2.5 py-1 rounded-lg text-xs border transition ' + cls + '">' +
      '<span class="sm:hidden" aria-hidden="true">' + icon + '</span>' +
      '<span class="hidden sm:inline">' + label + '</span>' +
      '</button>';
  }

  /** 组装列表查询参数（筛选条件下推到服务端） */
  function buildListQuery() {
    var params = new URLSearchParams();
    params.set('sort', sortType);
    params.set('order', sortOrder);
    params.set('page', String(currentPage));
    params.set('pageSize', String(PAGE_SIZE));
    if (searchKeyword) params.set('q', searchKeyword);
    if (dirFilter) params.set('dir', dirFilter);
    if (extFilter) params.set('ext', extFilter);
    // 收件箱：只返回最近十分钟内收到的文件
    if (inboxMode) params.set('since', String(Date.now() - INBOX_WINDOW));
    return params.toString();
  }

  function loadFiles() {
    return apiFetch(API + '/list?' + buildListQuery())
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) throw new Error(json.msg || '加载失败');
        renderList(json.data || {});
      })
      .catch(function () {
        // 拿不到列表时给出明确原因，避免和「没有文件」混淆
        $('emptyTip').classList.remove('hidden');
        $('emptyTip').textContent = '无法连接服务端，请确认设备与本机在同一局域网';
        $('fileCount').textContent = '';
      });
  }
  function updateBatchUI() {
    var names = Object.keys(selected).filter(function(n) { return selected[n]; });
    var count = names.length;
    // 全选的范围是当前页显示的文件
    var pageItems = currentPageItems();
    var total = pageItems.length;
    var selectedOnPage = pageItems.filter(function (f) { return selected[f.name]; }).length;
    $('batchBar').classList.toggle('hidden', allCount === 0);
    $('selectAll').checked = total > 0 && selectedOnPage === total;
    $('selectAll').indeterminate = selectedOnPage > 0 && selectedOnPage < total;
    if (count > 0) {
      $('selectedCount').classList.remove('hidden');
      $('selectedCount').querySelector('em').textContent = count;
      $('batchShare').disabled = false;
      $('batchDownload').disabled = false;
      $('batchMove').disabled = false;
      $('batchRename').disabled = false;
      $('batchDelete').disabled = false;
    } else {
      $('selectedCount').classList.add('hidden');
      $('batchShare').disabled = true;
      $('batchDownload').disabled = true;
      $('batchMove').disabled = true;
      $('batchRename').disabled = true;
      $('batchDelete').disabled = true;
    }
  }
  /** 更新分页控件状态 */
  function updatePager() {
    var pager = $('pager');
    var show = totalPages > 1;
    pager.classList.toggle('hidden', !show);
    if (!show) {
      $('pageInfo').textContent = '';
      return;
    }
    $('pageInfo').textContent = '第 ' + currentPage + '/' + totalPages + ' 页 · 共 ' + totalCount + ' 条';
    $('firstPage').disabled = currentPage <= 1;
    $('prevPage').disabled = currentPage <= 1;
    $('nextPage').disabled = currentPage >= totalPages;
    $('lastPage').disabled = currentPage >= totalPages;
  }

  /** 当前页显示的文件（用于全选范围） */
  function currentPageItems() {
    return fileItems;
  }

  // ---------------------------------------------------------------------------
  // 文件整理（重命名 / 移动 / 批量重命名）
  //
  // 整理结果直接体现在服务端的真实目录结构上，
  // 前端只负责收集参数，并把服务端返回的新名字同步回列表。
  // ---------------------------------------------------------------------------
  /** 当前正在重命名的文件 */
  var renameTarget = '';
  /** 当前正在移动的文件列表 */
  var moveTargets = [];
  /** 当前正在批量重命名的文件列表 */
  var batchTargets = [];
  /** 服务端返回的目录与扩展名筛选项 */
  var facetDirs = [];
  var facetExts = [];

  /** 打开重命名弹窗 */
  function openRenameDialog(name) {
    renameTarget = name;
    var dir = dirOf(name);
    $('renameInput').value = dir ? name.slice(dir.length + 1) : name;
    $('renameDirHint').textContent = '当前位置：' + (dir ? dir + '/' : '根目录');
    $('renameModal').classList.remove('hidden');
    setTimeout(function () {
      $('renameInput').focus();
      $('renameInput').select();
    }, 60);
  }

  /**
   * 把用户输入的目标名拼成相对存储目录的路径。
   *
   * 只填文件名 → 留在当前目录改名；
   * 以 / 开头 → 相对根目录；
   * 含 / → 相对根目录的多级路径。
   */
  function buildRenameTarget(from, input) {
    var value = input.trim();
    if (value.charAt(0) === '/') return value.slice(1);
    if (value.indexOf('/') >= 0) return value;
    var dir = dirOf(from);
    return dir ? dir + '/' + value : value;
  }

  /** 关闭重命名弹窗 */
  function closeRenameDialog() {
    $('renameModal').classList.add('hidden');
    renameTarget = '';
  }

  /** 提交重命名 */
  function submitRename() {
    var from = renameTarget;
    var input = $('renameInput').value.trim();
    if (!from) return;
    if (!input) {
      toast('请填写新的名称', 'err');
      return;
    }
    var to = buildRenameTarget(from, input);
    // 自己改的文件不再触发「收到新文件」提示
    suppressNotifyUntil = Date.now() + 2000;
    apiFetch(API + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: to }),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) {
          toast(json.msg || '重命名失败', 'err');
          return;
        }
        // 选中状态跟着文件的新名字走
        if (selected[from]) {
          delete selected[from];
          selected[json.data.to] = true;
        }
        // 自己改的名不再提示「收到新文件」
        ownUploads[json.data.to] = Date.now();
        closeRenameDialog();
        toast('已重命名为 ' + json.data.to, 'ok');
        refreshAll();
      })
      .catch(function () { toast('重命名失败', 'err'); });
  }

  /** 打开移动弹窗 */
  function openMoveDialog(names) {
    moveTargets = names.slice();
    $('moveCount').textContent = '（' + names.length + ' 个文件）';
    $('moveDirInput').value = '';
    // 目录列表来自服务端，能看到所有已存在的目录
    var html = '<button class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 transition" data-dir="">根目录</button>';
    facetDirs.forEach(function (d) {
      html += '<button class="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 transition" data-dir="' + escapeHtml(d.path) + '">' + escapeHtml(d.path) + '</button>';
    });
    $('moveDirList').innerHTML = html;
    $('moveModal').classList.remove('hidden');
  }

  /** 关闭移动弹窗 */
  function closeMoveDialog() {
    $('moveModal').classList.add('hidden');
    moveTargets = [];
  }

  /** 提交移动 */
  function submitMove() {
    var names = moveTargets.slice();
    if (!names.length) return;
    var dir = $('moveDirInput').value.trim();
    suppressNotifyUntil = Date.now() + 2000;
    apiFetch(API + '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: names, dir: dir }),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) {
          toast(json.msg || '移动失败', 'err');
          return;
        }
        var moved = (json.data && json.data.moved) || [];
        var failed = (json.data && json.data.failed) || [];
        // 移动后选中状态同步到新路径
        moved.forEach(function (m) {
          if (selected[m.from]) {
            delete selected[m.from];
            selected[m.to] = true;
          }
          // 自己移动的文件不再提示「收到新文件」
          ownUploads[m.to] = Date.now();
        });
        closeMoveDialog();
        if (failed.length) {
          toast('已移动 ' + moved.length + ' 个，' + failed.length + ' 个失败', 'err');
        } else {
          toast('已移动 ' + moved.length + ' 个文件', 'ok');
        }
        refreshAll();
      })
      .catch(function () { toast('移动失败', 'err'); });
  }

  /** 收集批量重命名规则 */
  function collectRule() {
    var mode = $('batchRuleMode').value;
    var rule = { mode: mode };
    if (mode === 'prefix') rule.prefix = $('rulePrefix') ? $('rulePrefix').value : '';
    else if (mode === 'suffix') rule.suffix = $('ruleSuffix') ? $('ruleSuffix').value : '';
    else if (mode === 'replace') {
      rule.find = $('ruleFind') ? $('ruleFind').value : '';
      rule.replace = $('ruleReplace') ? $('ruleReplace').value : '';
    } else if (mode === 'sequence') {
      rule.start = Number($('ruleStart') ? $('ruleStart').value : 1) || 1;
      rule.padding = Number($('rulePadding') ? $('rulePadding').value : 0) || 0;
      rule.template = $('ruleTemplate') ? $('ruleTemplate').value : '{n}';
    }
    var ext = $('ruleExt');
    if (ext && ext.value) rule.ext = ext.value;
    return rule;
  }

  /**
   * 本地预览重命名结果（与服务端规则保持一致）。
   * 只用于给用户看效果，真正的重命名仍由服务端执行。
   */
  function previewRename(base, rule, index) {
    if (rule.mode === 'prefix') return (rule.prefix || '') + base;
    if (rule.mode === 'suffix') return base + (rule.suffix || '');
    if (rule.mode === 'replace') {
      if (!rule.find) return base;
      return base.split(rule.find).join(rule.replace || '');
    }
    var start = rule.start || 1;
    var num = rule.padding ? String(start + index).padStart(rule.padding, '0') : String(start + index);
    return (rule.template || '{n}').replace('{n}', num).replace('{name}', base);
  }

  /** 更新批量重命名的预览提示 */
  function updateRulePreview() {
    var rule = collectRule();
    var sample = batchTargets[0];
    var el = $('batchRulePreview');
    if (!el) return;
    if (!sample) {
      el.textContent = '';
      return;
    }
    var fileName = sample.slice(sample.lastIndexOf('/') + 1);
    var dot = fileName.lastIndexOf('.');
    var base = dot > 0 ? fileName.slice(0, dot) : fileName;
    var ext = dot > 0 ? fileName.slice(dot) : '';
    var next = previewRename(base, rule, 0) + ext;
    el.textContent = '示例：' + fileName + ' → ' + next + (batchTargets.length > 1 ? '（共 ' + batchTargets.length + ' 个文件）' : '');
  }

  /** 按当前模式渲染规则参数 */
  function renderRuleParams() {
    var mode = $('batchRuleMode').value;
    var inputCls = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-emerald-500/60';
    var html = '';
    if (mode === 'prefix') {
      html += '<input id="rulePrefix" type="text" placeholder="前缀，如 备份-" class="' + inputCls + '" />';
    } else if (mode === 'suffix') {
      html += '<input id="ruleSuffix" type="text" placeholder="后缀，如 -副本" class="' + inputCls + '" />';
    } else if (mode === 'replace') {
      html += '<input id="ruleFind" type="text" placeholder="查找，如 2024" class="' + inputCls + '" />';
      html += '<input id="ruleReplace" type="text" placeholder="替换为，如 2025" class="' + inputCls + '" />';
    } else if (mode === 'sequence') {
      html += '<div class="flex gap-2">';
      html += '<input id="ruleStart" type="number" min="0" value="1" placeholder="起始序号" class="' + inputCls + ' flex-1" />';
      html += '<input id="rulePadding" type="number" min="0" max="10" value="2" placeholder="补零位数" class="' + inputCls + ' flex-1" />';
      html += '</div>';
      html += '<input id="ruleTemplate" type="text" value="{n}" placeholder="模板，{n} 为序号、{name} 为原名" class="' + inputCls + '" />';
    }
    // 扩展名过滤：只处理某一类文件时可以限定范围
    html += '<select id="ruleExt" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none">';
    html += '<option value="">全部类型</option>';
    facetExts.forEach(function (e) {
      html += '<option value="' + escapeHtml(e.ext) + '">.' + escapeHtml(e.ext) + '（' + e.count + '）</option>';
    });
    html += '</select>';
    $('batchRuleParams').innerHTML = html;
    updateRulePreview();
  }

  /** 打开批量重命名弹窗 */
  function openBatchRenameDialog(names) {
    batchTargets = names.slice();
    $('batchRenameCount').textContent = '（' + names.length + ' 个文件）';
    renderRuleParams();
    $('batchRenameModal').classList.remove('hidden');
  }

  /** 关闭批量重命名弹窗 */
  function closeBatchRenameDialog() {
    $('batchRenameModal').classList.add('hidden');
    batchTargets = [];
  }

  /** 提交批量重命名 */
  function submitBatchRename() {
    var names = batchTargets.slice();
    if (!names.length) return;
    var rule = collectRule();
    suppressNotifyUntil = Date.now() + 2000;
    apiFetch(API + '/rename-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: names, rule: rule }),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) {
          toast(json.msg || '批量重命名失败', 'err');
          return;
        }
        var renamed = (json.data && json.data.renamed) || [];
        var failed = (json.data && json.data.failed) || [];
        var skipped = (json.data && json.data.skipped) || [];
        // 重命名后选中状态同步到新名字
        renamed.forEach(function (m) {
          if (selected[m.from]) {
            delete selected[m.from];
            selected[m.to] = true;
          }
          // 自己改的名字不再提示「收到新文件」
          ownUploads[m.to] = Date.now();
        });
        closeBatchRenameDialog();
        var tip = '已重命名 ' + renamed.length + ' 个文件';
        if (skipped.length) tip += '，' + skipped.length + ' 个未变化';
        if (failed.length) tip += '，' + failed.length + ' 个失败';
        toast(tip, failed.length ? 'err' : 'ok');
        refreshAll();
      })
      .catch(function () { toast('批量重命名失败', 'err'); });
  }

  // ---------------------------------------------------------------------------
  // 本地目录自动上传
  //
  // 选中一个本地目录后定时扫描，目录里新增或修改的文件会自动上传到服务端。
  // 依赖 File System Access API（Chrome / Edge 等），不支持的浏览器会给出提示。
  // ---------------------------------------------------------------------------
  var watchHandle = null; // 被监听的目录句柄
  var watchTimer = null; // 扫描定时器
  var watchSeen = {}; // 已上传文件的标识：名称:大小:修改时间
  var WATCH_INTERVAL = 3000; // 扫描间隔（毫秒）

  /** 更新监听状态提示 */
  function updateWatchStatus() {
    var el = $('watchStatus');
    if (!el) return;
    if (!watchHandle) {
      el.classList.add('hidden');
      el.classList.remove('flex');
      el.textContent = '';
      $('watchDirBtn').textContent = '📡 监听目录';
      return;
    }
    el.classList.remove('hidden');
    el.classList.add('flex');
    el.innerHTML = '<span>📡 正在监听「' + escapeHtml(watchHandle.name) + '」</span>' +
      '<button id="watchStopBtn" class="px-1.5 py-0.5 rounded border border-slate-700 hover:bg-slate-700 transition">停止</button>';
    $('watchDirBtn').textContent = '📡 换个目录';
    $('watchStopBtn').addEventListener('click', stopWatchDir);
  }

  /** 停止监听 */
  function stopWatchDir() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    watchHandle = null;
    watchSeen = {};
    updateWatchStatus();
    toast('已停止监听本地目录');
  }

  /** 扫描一次目录，把新增文件加入上传队列 */
  async function scanWatchDir() {
    if (!watchHandle) return;
    var handle = watchHandle;
    try {
      var jobs = [];
      for await (var entry of handle.values()) {
        if (entry.kind !== 'file') continue;
        jobs.push(
          entry
            .getFile()
            .then(function (file) {
              // 用「名称:大小:修改时间」判断是否已经传过
              var key = entry.name + ':' + file.size + ':' + file.lastModified;
              if (watchSeen[key]) return;
              watchSeen[key] = true;
              enqueueUpload(file, entry.name);
            })
            .catch(function () {
              // 单个文件读取失败不影响其它文件
            })
        );
      }
      await Promise.all(jobs);
      pumpQueue();
    } catch (e) {
      // 目录权限失效等情况忽略，等待下一次扫描
    }
  }

  /** 选择目录并开始监听 */
  function startWatchDir() {
    if (!window.showDirectoryPicker) {
      toast('当前浏览器不支持目录监听，请使用 Chrome / Edge 桌面版', 'err');
      return;
    }
    if (!window.isSecureContext) {
      toast('目录监听需要 https 或 localhost 环境', 'err');
      return;
    }
    window
      .showDirectoryPicker({ mode: 'read' })
      .then(function (handle) {
        watchHandle = handle;
        watchSeen = {};
        if (watchTimer) clearInterval(watchTimer);
        watchTimer = setInterval(scanWatchDir, WATCH_INTERVAL);
        updateWatchStatus();
        scanWatchDir();
        toast('已开始监听「' + handle.name + '」，新增文件会自动上传');
      })
      .catch(function (err) {
        // 用户取消选择时无需提示
        if (err && err.name === 'AbortError') return;
        toast('无法监听该目录', 'err');
      });
  }

  /** 取文件所在目录（相对路径，无目录时返回空串） */
  function dirOf(name) {
    var i = name.lastIndexOf('/');
    return i < 0 ? '' : name.slice(0, i);
  }

  // ---------------------------------------------------------------------------
  // 收件箱与实时通知
  //
  // 服务端通过 SSE 推送文件变更，页面收到后立即刷新列表并提示，
  // 这样手机端放着一台「接文件」的机器时，不用手动刷新就知道来新文件了。
  // ---------------------------------------------------------------------------

  /** 刷新收件箱按钮上的未读计数 */
  function updateInboxBadge() {
    var el = $('inboxCount');
    if (!el) return;
    if (inboxNewCount > 0) {
      el.classList.remove('hidden');
      el.textContent = inboxNewCount;
    } else {
      el.classList.add('hidden');
      el.textContent = '';
    }
    $('inboxBtn').classList.toggle('border-emerald-500/60', inboxMode);
    $('inboxBtn').classList.toggle('text-emerald-400', inboxMode);
  }

  /** 系统级通知（用户授权后才发送） */
  function notifySystem(names) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      var body = names.slice(0, 3).join('、') + (names.length > 3 ? ' 等 ' + names.length + ' 个文件' : '');
      var notice = new Notification('收到新文件', { body: body, icon: '/localsend/favicon.png', tag: 'localsend-inbox' });
      notice.onclick = function () {
        window.focus();
        notice.close();
      };
    } catch (e) {
      // 通知失败不影响主流程
    }
  }

  /** 处理服务端推送的文件变更 */
  function handleIncoming(names) {
    var now = Date.now();
    // 自己刚做的整理操作（重命名、移动等）也会触发变更推送，
    // 这段时间内不再提示「收到新文件」，避免把操作结果当成别人的文件
    if (now < suppressNotifyUntil) {
      refreshAll();
      return;
    }
    // 过滤掉本机刚上传的文件，避免自己提示自己
    var fresh = names.filter(function (n) {
      var at = ownUploads[n];
      if (at && now - at < 10000) {
        delete ownUploads[n];
        return false;
      }
      return true;
    });
    refreshAll();
    if (!fresh.length) return;
    inboxNewCount += fresh.length;
    updateInboxBadge();
    var text = fresh.length === 1 ? '收到新文件：' + fresh[0] : '收到 ' + fresh.length + ' 个新文件：' + fresh.slice(0, 2).join('、');
    toast(text, 'ok');
    notifySystem(fresh);
  }

  /** 事件流连接代号：异步换票期间可能已经重新连接，旧回调要作废 */
  var eventsGeneration = 0;

  /** 订阅服务端文件变更事件 */
  function connectEvents() {
    if (!window.EventSource) return;
    // 认证失效期间不再订阅：连上去只会不断拿到 401
    if (authBlocked) return;
    // 已有连接时先断开，避免重复订阅
    closeEvents();
    var generation = ++eventsGeneration;
    // EventSource 带不了请求头，用短期票据代替把会话写进 URL
    ticketUrl('events', [], '/events')
      .then(function (url) {
        // 换票期间可能已经断线重连或退出登录，旧请求直接作废
        if (generation !== eventsGeneration || authBlocked) return;
        try {
          eventSource = new EventSource(url);
        } catch (e) {
          return;
        }
        eventSource.addEventListener('changed', function (e) {
          var payload = null;
          try {
            payload = JSON.parse(e.data);
          } catch (err) {
            return;
          }
          handleIncoming((payload && payload.names) || []);
        });
        /**
         * 连接断开时浏览器会按 retry 间隔自动重连。
         *
         * 票据到期或连接被拒时浏览器会彻底放弃（readyState = CLOSED），
         * 这时才重新换票并重建连接；仍在重连中（CONNECTING）就交给浏览器，
         * 避免每次抖动都多发一次请求。
         *
         * 如果是因为会话失效导致的拒绝，先探测一次会话状态，
         * 确认失效就进入统一的重新认证流程（清会话、停后台任务、提示登录）。
         */
        eventSource.onerror = function () {
          if (authBlocked) {
            closeEvents();
            return;
          }
          if (eventSource && eventSource.readyState !== 2) return;
          var now = Date.now();
          // 限制重建频率：断线可能连续触发多次
          if (now - sseProbeAt < 5000) return;
          sseProbeAt = now;
          refreshSession().then(function (ok) {
            if (ok) connectEvents();
          });
        };
      })
      .catch(function () {
        // 换票失败（比如服务端刚重启）：稍后再试，不打扰用户
        if (authBlocked) return;
        setTimeout(function () {
          if (!authBlocked && generation === eventsGeneration) connectEvents();
        }, 5000);
      });
  }

  /**
   * 断开事件流。
   *
   * 会话失效时必须主动断开：EventSource 会自动重连，
   * 未授权的重连很快就会把接口频率限制打满，连正常请求都会被牵连。
   */
  function closeEvents() {
    // 让仍在换票过程中的连接尝试作废
    eventsGeneration += 1;
    if (!eventSource) return;
    try {
      eventSource.close();
    } catch (e) {
      // 忽略关闭异常
    }
    eventSource = null;
  }

  /** 刷新目录筛选下拉选项（数据来自服务端，前端不再需要全量列表） */
  function updateDirOptions(dirs, rootCount) {
    var sel = $('dirSelect');
    if (!sel) return;
    var html = '<option value="">全部目录</option>';
    if (rootCount) html += '<option value="__root__">根目录（' + rootCount + '）</option>';
    dirs.forEach(function (d) {
      html += '<option value="' + escapeHtml(d.path) + '">' + escapeHtml(d.path) + '（' + d.count + '）</option>';
    });
    sel.innerHTML = html;
    // 目录已不存在（被删除或移动）时回到「全部目录」
    var exists = dirs.some(function (d) { return d.path === dirFilter; });
    if (dirFilter && dirFilter !== '__root__' && !exists) dirFilter = '';
    sel.value = dirFilter;
    // 上传目标的可选项与目录筛选同源
    updateUploadDirOptions();
  }

  /**
   * 刷新「上传到」下拉。
   *
   * 上传目标默认跟随当前筛选目录，也可以单独改：
   * 在「归档/2026」视图里上传，文件就落在这个目录，不必传完再移动一次。
   */
  function updateUploadDirOptions() {
    var sel = $('uploadDirSelect');
    if (!sel) return;
    var html = '<option value="">根目录</option>';
    facetDirs.forEach(function (d) {
      html += '<option value="' + escapeHtml(d.path) + '">' + escapeHtml(d.path) + '</option>';
    });
    // 当前目标是新出现的目录时也补一个选项，避免下拉选不中
    var known = !uploadTargetDir || facetDirs.some(function (d) { return d.path === uploadTargetDir; });
    if (!known) html += '<option value="' + escapeHtml(uploadTargetDir) + '">' + escapeHtml(uploadTargetDir) + '</option>';
    sel.innerHTML = html;
    sel.value = uploadTargetDir;
  }

  /** 切换目录筛选：上传目标跟着走 */
  function setDirFilter(value) {
    dirFilter = value;
    currentPage = 1;
    uploadTargetDir = dirFilter && dirFilter !== '__root__' ? dirFilter : '';
    updateUploadDirOptions();
  }

  /** 刷新扩展名筛选下拉选项 */
  function updateExtOptions(exts) {
    var sel = $('extSelect');
    if (!sel) return;
    var html = '<option value="">全部类型</option>';
    exts.forEach(function (e) {
      html += '<option value="' + escapeHtml(e.ext) + '">.' + escapeHtml(e.ext) + '（' + e.count + '）</option>';
    });
    sel.innerHTML = html;
    // 该类型已不存在时回到「全部类型」
    var exists = exts.some(function (e) { return e.ext === extFilter; });
    if (extFilter && !exists) extFilter = '';
    sel.value = extFilter;
  }

  /** 拉取筛选选项（目录 / 扩展名） */
  function loadFacets() {
    return apiFetch(API + '/facets')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) return;
        var data = json.data || {};
        facetDirs = data.dirs || [];
        facetExts = data.exts || [];
        updateDirOptions(facetDirs, data.rootCount || 0);
        updateExtOptions(facetExts);
      })
      .catch(function () {
        // 筛选选项拉取失败不影响主流程，静默忽略
      });
  }

  /** 拉取存储用量并刷新进度条 */
  function loadUsage() {
    return apiFetch(API + '/usage')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) return;
        var d = json.data || {};
        var used = Number(d.used) || 0;
        var limit = Number(d.limit) || 0;
        var trash = Number(d.trash) || 0;
        var bar = $('usageBar');
        if (!bar) return;
        bar.classList.remove('hidden');
        $('usageText').textContent = limit
          ? '已用 ' + fmtSize(used) + ' / ' + fmtSize(limit) + '（剩余 ' + fmtSize(Math.max(0, limit - used)) + '）'
          : '已用 ' + fmtSize(used) + ' · 未设容量上限';
        $('usageTrash').textContent = trash ? '回收站 ' + fmtSize(trash) : '';
        var fill = $('usageFill');
        if (!limit) {
          fill.style.width = '0%';
          return;
        }
        var pct = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
        fill.style.width = pct + '%';
        fill.className = 'h-full transition-all ' + (pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500');
      })
      .catch(function () {
        /* 用量拿不到不影响主流程 */
      });
  }

  /** 文件变动后同时刷新列表、筛选选项与用量 */
  function refreshAll() {
    loadFiles();
    loadFacets();
    loadUsage();
  }

  function renderList(data) {
    var items = (data && data.items) || [];
    fileItems = items;
    // 分页信息由服务端给出，页码可能被收敛（如删完最后一页）
    totalPages = Math.max(1, Number(data && data.totalPages) || 1);
    currentPage = Math.max(1, Number(data && data.page) || 1);
    totalCount = Number(data && data.total) || 0;
    allCount = Number(data && data.allTotal) || 0;

    var wrap = $('fileList');
    // 重绘前解除旧的缩略图监听，避免观察者持有已移除的节点
    if (thumbObserver) {
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-thumb]'), function (el) { thumbObserver.unobserve(el); });
    }
    wrap.innerHTML = '';
    var isEmpty = allCount === 0;
    $('emptyTip').classList.toggle('hidden', !isEmpty);
    if (!isEmpty && items.length === 0) {
      $('emptyTip').classList.remove('hidden');
      $('emptyTip').textContent = searchKeyword
        ? '没有匹配「' + searchKeyword + '」的文件'
        : inboxMode ? '收件箱里还没有新文件（最近 ' + Math.round(INBOX_WINDOW / 60000) + ' 分钟）' : '没有匹配当前筛选条件的文件';
    } else {
      $('emptyTip').textContent = '暂无文件，上传第一个文件开始传输吧';
    }
    $('fileCount').textContent = (searchKeyword || dirFilter || extFilter || inboxMode)
      ? '(' + totalCount + '/' + allCount + ')'
      : '(' + allCount + ')';
    updateBatchUI();
    updatePager();
    items.forEach(function (f) {
      var div = document.createElement('div');
      div.className = 'flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 hover:bg-slate-800/60 transition flex-wrap' + (selected[f.name] ? ' bg-slate-800/40' : '');
      div.dataset.name = f.name;
      if (highlightNames[f.name]) div.classList.add('file-new-flash');
      // 子目录文件：主标题显示文件名，前面带可点击的目录标记
      var dir = dirOf(f.name);
      var base = dir ? f.name.slice(dir.length + 1) : f.name;
      div.innerHTML =
        '<label class="flex items-center shrink-0 cursor-pointer"><input type="checkbox" class="file-check accent-emerald-500 w-3.5 h-3.5" data-name="' + escapeHtml(f.name) + '"' + (selected[f.name] ? ' checked' : '') + '></label>' +
        (isThumbImage(f.name) && f.size <= THUMB_MAX_SIZE
          ? '<span data-thumb="' + escapeHtml(f.name) + '" class="relative w-10 h-10 sm:w-12 sm:h-12 shrink-0 flex items-center justify-center">' +
              '<span class="text-xl sm:text-2xl">' + fileIcon(f.name) + '</span>' +
              '<img alt="" class="absolute inset-0 w-full h-full rounded-lg object-cover bg-slate-800 opacity-0 transition-opacity" />' +
            '</span>'
          : '<span class="text-xl sm:text-2xl shrink-0">' + fileIcon(f.name) + '</span>') +
        '<div class="min-w-0 flex-1">' +
          '<div class="text-sm truncate text-slate-200" title="' + escapeHtml(f.name) + '">' +
            (dir ? '<span class="text-slate-500 hover:text-emerald-400 cursor-pointer" data-dir="' + escapeHtml(dir) + '" title="只看该目录">' + escapeHtml(dir) + '/</span> ' : '') +
            escapeHtml(base) +
          '</div>' +
          '<div class="text-xs text-slate-500 mt-0.5">' + fmtSize(f.size) + ' · ' + fmtTime(f.mtime) + '</div>' +
        '</div>' +
        '<div class="flex items-center gap-1 sm:gap-1.5 shrink-0 justify-end w-full sm:w-auto">' +
          btn('预览', 'preview', false, '👁') + btn('下载', 'download', false, '⬇️') +
          (canWrite() ? btn('分享', 'share', false, '🔗') : '') +
          (canSystemShare() ? btn('系统分享', 'syshare', false, '📤') : '') +
          // 扫码与分享同源：都是生成免登录的分享链接，不再暴露带凭据的直链
          (canWrite() ? btn('扫码分享', 'qr', false, '📱') : '') +
          // 整理与删除属于危险操作，只有管理员能看到
          (isAdmin() ? btn('重命名', 'rename', false, '✏️') + btn('移动', 'move', false, '📂') + btn('删除', 'delete', true, '🗑') : '') +
        '</div>';
      Array.prototype.forEach.call(div.querySelectorAll('button'), function (b) { b.dataset.name = f.name; });
      wrap.appendChild(div);
      // 图片缩略图：进入可视区域后再生成
      var thumbEl = div.querySelector('[data-thumb]');
      if (thumbEl) observeThumb(thumbEl);
    });

    // 上传后定位并高亮新出现的文件
    if (pendingHighlight.length) {
      var names = pendingHighlight;
      pendingHighlight = [];
      var found = names.filter(function (n) { return items.some(function (f) { return f.name === n; }); });
      if (found.length) {
        found.forEach(function (n) { highlightNames[n] = true; });
        // 直接给已渲染的行加上高亮样式，并滚动定位到第一个
        var rows = wrap.querySelectorAll(':scope > div');
        var target = null;
        for (var i = 0; i < rows.length; i++) {
          if (found.indexOf(rows[i].dataset.name) >= 0) {
            rows[i].classList.add('file-new-flash');
            if (!target) target = rows[i];
          }
        }
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        // 3 秒后淡出高亮
        setTimeout(function () {
          Object.keys(highlightNames).forEach(function (n) { delete highlightNames[n]; });
          wrap.querySelectorAll(':scope > div.file-new-flash').forEach(function (el) {
            el.classList.remove('file-new-flash');
          });
        }, 3000);
      }
    }
  }

  /**
   * 递归展开拖拽进来的目录条目。
   *
   * 浏览器拖拽文件夹时只会给出目录条目本身，需要逐层读取子项，
   * 最终返回 [{ file, rel }] 列表，rel 为带目录前缀的相对路径。
   */
  function readEntry(entry, prefix) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(
          function (f) { resolve([{ file: f, rel: prefix + f.name }]); },
          function () { resolve([]); }
        );
        return;
      }
      if (!entry.isDirectory) {
        resolve([]);
        return;
      }
      var reader = entry.createReader();
      var pending = [];
      var readBatch = function () {
        reader.readEntries(
          function (list) {
            // 每次最多返回 100 项，读到空数组才算读完
            if (!list.length) {
              Promise.all(pending).then(function (parts) {
                var out = [];
                parts.forEach(function (arr) { out = out.concat(arr); });
                resolve(out);
              });
              return;
            }
            list.forEach(function (child) { pending.push(readEntry(child, prefix + entry.name + '/')); });
            readBatch();
          },
          function () { resolve([]); }
        );
      };
      readBatch();
    });
  }

  /**
   * 加入上传队列。
   *
   * 上传文件夹时浏览器会给出 webkitRelativePath（形如「目录/子目录/文件.txt」），
   * 这里把它作为 multipart 的 filename 一起发送，服务端据此还原目录结构。
   */
  function uploadFiles(fileList) {
    Array.prototype.forEach.call(fileList, function (f) {
      var rel = f.webkitRelativePath || f.name;
      enqueueUpload(f, rel);
    });
    pumpQueue();
  }

  // ---------------------------------------------------------------------------
  // 上传并发队列
  //
  // 服务端对单 IP 的并发上传数有上限（默认 3），一次选中几十个文件时
  // 若同时发起所有请求，超出的会被直接拒绝（429）。
  // 这里用队列把并发控制在安全范围内，并对被限流的请求自动退避重试。
  // ---------------------------------------------------------------------------
  var UPLOAD_CONCURRENCY = 3; // 与服务端 maxConcurrent 默认值保持一致
  var MAX_RETRY = 3; // 单个文件最多重试次数
  var CHUNK_THRESHOLD = 8 * 1024 * 1024; // 超过 8MB 走分片并发上传
  var CHUNK_SIZE = 4 * 1024 * 1024; // 分片大小 4MB
  var CHUNK_CONCURRENCY = 3; // 并发分片数（与服务端并发上限一致）

  // 续传记录：文件指纹 -> uploadId。断线、刷新页面、服务重启后据此接上。
  var UPLOAD_IDS_KEY = 'localsend.uploads';
  var UPLOAD_IDS_MAX = 20; // 最多记住 20 个未完成任务，避免 localStorage 无限增长

  /** 文件指纹：名称 + 大小 + 修改时间。同名但内容变了的文件不会被误续传 */
  function fileKeyOf(rel, file) {
    return rel + ':' + file.size + ':' + (file.lastModified || 0);
  }

  function readUploadIds() {
    try {
      var map = JSON.parse(localStorage.getItem(UPLOAD_IDS_KEY) || '{}');
      return map && typeof map === 'object' ? map : {};
    } catch (e) {
      return {};
    }
  }

  /** 取该文件上次的任务 ID */
  function getUploadId(fileKey) {
    return readUploadIds()[fileKey] || '';
  }

  /** 记录/清除续传任务（id 为空表示清除） */
  function saveUploadId(fileKey, id) {
    var map = readUploadIds();
    if (id) map[fileKey] = id;
    else delete map[fileKey];
    var keys = Object.keys(map);
    while (keys.length > UPLOAD_IDS_MAX) delete map[keys.shift()];
    try {
      localStorage.setItem(UPLOAD_IDS_KEY, JSON.stringify(map));
    } catch (e) {
      // 存储不可用时忽略：只是失去跨刷新的续传能力
    }
  }
  var uploadQueue = []; // 待上传的文件
  var uploadActive = 0; // 当前进行中的上传数
  var activeItems = []; // 进行中的任务（每项带 cancel 方法，供「全部取消」调用）
  var uploadDone = 0; // 已完成（含失败）的数量
  var uploadFailed = 0; // 失败数量
  var uploadCanceled = 0; // 用户主动取消的数量
  var uploadTotal = 0; // 本批次总数
  var listReloadTimer = null;

  /** 延迟刷新列表，避免每个文件上传完都请求一次 */
  function scheduleListReload() {
    if (listReloadTimer) return;
    listReloadTimer = setTimeout(function () {
      listReloadTimer = null;
      refreshAll();
    }, 600);
  }

  /**
   * 等待新文件出现在列表中，然后定位高亮。
   *
   * 服务端写入后需要重新扫描目录，列表可能慢一步到达；
   * 这里反复刷新列表直到新文件出现，再触发一次渲染让高亮生效。
   * 多个文件同时上传时统一累积到同一队列，避免互相干扰。
   */
  function waitForHighlight(names) {
    names.forEach(function (n) {
      if (highlightQueue.indexOf(n) < 0) highlightQueue.push(n);
    });
    if (highlightTimer) return;
    highlightTimer = setTimeout(tryHighlight, 250);
  }

  function tryHighlight() {
    highlightTimer = null;
    if (!highlightQueue.length) return;
    loadFiles().then(function () {
      var found = highlightQueue.filter(function (n) {
        return fileItems.some(function (f) { return f.name === n; });
      });
      if (!found.length) {
        // 文件还没出现在列表中，稍后再试
        highlightTimer = setTimeout(tryHighlight, 300);
        return;
      }
      // 找到后加入待高亮集合，再次渲染让高亮样式生效
      pendingHighlight = pendingHighlight.concat(found);
      highlightQueue = highlightQueue.filter(function (n) { return found.indexOf(n) < 0; });
      loadFiles();
    });
  }

  function updateQueueSummary() {
    var el = $('uploadSummary');
    if (!el) return;
    if (!uploadTotal) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    var pending = uploadQueue.length;
    var running = uploadActive;
    el.innerHTML =
      '<span class="text-slate-400">本批次</span>' +
      '<span class="text-emerald-400 font-mono">' + (uploadDone + running) + '/' + uploadTotal + '</span>' +
      '<span class="text-slate-400">已完成</span>' +
      (running ? '<span class="text-sky-400 font-mono">' + running + '</span><span class="text-slate-400">传输中</span>' : '') +
      (pending ? '<span class="text-slate-400 font-mono">' + pending + '</span><span class="text-slate-400">排队中</span>' : '') +
      (uploadCanceled ? '<span class="text-slate-400 font-mono">' + uploadCanceled + '</span><span class="text-slate-400">已取消</span>' : '') +
      (uploadFailed ? '<span class="text-red-400 font-mono">' + uploadFailed + '</span><span class="text-slate-400">失败</span>' : '') +
      (running || pending
        ? '<button data-cancel-all class="ml-auto px-2 py-0.5 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition shrink-0">全部取消</button>'
        : '');
    var cancelAll = el.querySelector('[data-cancel-all]');
    if (cancelAll) cancelAll.addEventListener('click', cancelAllUploads);
  }

  /** 取消本批次所有还没传完的文件 */
  function cancelAllUploads() {
    var pendingCount = uploadQueue.length;
    uploadQueue.length = 0;
    uploadTotal = Math.max(0, uploadTotal - pendingCount);
    var running = activeItems.slice();
    running.forEach(function (item) {
      if (item.cancel) item.cancel();
    });
    // 没有进行中的任务时不会有回调来收尾，这里手动清空批次状态
    if (!running.length) {
      uploadTotal = 0;
      uploadDone = 0;
      uploadFailed = 0;
      uploadCanceled = 0;
      updateQueueSummary();
    }
    toast('已取消未完成的上传');
  }

  /**
   * 加入上传队列。
   *
   * alreadyResolved 为 true 表示 rel 已经是最终相对路径（重试时用），
   * 否则按当前「上传到」的目录补上前缀。
   */
  function enqueueUpload(file, rel, alreadyResolved) {
    var name = rel || file.name;
    if (!alreadyResolved && uploadTargetDir) name = uploadTargetDir + '/' + name;
    uploadQueue.push({ file: file, rel: name });
    uploadTotal += 1;
    updateQueueSummary();
  }

  /** 从队列中取出下一个文件开始上传 */
  function pumpQueue() {
    while (uploadActive < UPLOAD_CONCURRENCY && uploadQueue.length) {
      var item = uploadQueue.shift();
      uploadActive += 1;
      uploadOne(item, 0, function (ok, canceled) {
        uploadActive -= 1;
        uploadDone += 1;
        if (canceled) uploadCanceled += 1;
        else if (!ok) uploadFailed += 1;
        updateQueueSummary();
        if (uploadDone >= uploadTotal) {
          // 本批次结束
          uploadQueue = [];
          uploadTotal = 0;
          uploadDone = 0;
          uploadFailed = 0;
          uploadCanceled = 0;
          setTimeout(function () {
            updateQueueSummary();
            refreshAll();
          }, 300);
        } else {
          pumpQueue();
        }
      });
    }
    updateQueueSummary();
  }

  /**
   * 大文件分片并发上传（支持断点续传）。
   *
   * 单条 HTTP 流在弱网下容易成为瓶颈，把文件切片后并发上传可以让多条流同时传输，
   * 局域网内大文件的速度提升明显。
   *
   * 续传：用「文件名:大小:修改时间」作为文件指纹，把拿到的 uploadId 记在
   * localStorage 里。断线、刷新页面、甚至服务重启之后，带着指纹和 uploadId
   * 重新 init，服务端会返回已上传的分片，只补传缺的那些。
   */
  function uploadByChunks(item, ui) {
    var file = item.file;
    var rel = item.rel || file.name;
    var startTime = Date.now();
    var uploadId = '';
    var fileKey = fileKeyOf(rel, file);

    /** 上传单个分片，遇到并发限流时退避重试 */
    function sendChunk(index, chunkSize) {
      var start = index * chunkSize;
      var blob = file.slice(start, Math.min(start + chunkSize, file.size));
      var fd = new FormData();
      fd.append('chunk', blob, 'chunk-' + index);
      var attempt = 0;
      function once() {
        return apiFetch(API + '/chunk/upload?uploadId=' + encodeURIComponent(uploadId) + '&index=' + index, { method: 'POST', body: fd })
          .then(function (r) {
            if (r.status === 429 && attempt < MAX_RETRY) {
              attempt += 1;
              return new Promise(function (resolve) { setTimeout(resolve, 600 * Math.pow(2, attempt - 1)); }).then(once);
            }
            return r.json();
          })
          .then(function (j) {
            if (!j || j.code !== 0) throw new Error((j && j.msg) || '分片上传失败');
            return j;
          });
      }
      return once();
    }

    apiFetch(API + '/chunk/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: rel,
        size: file.size,
        chunkSize: CHUNK_SIZE,
        fileKey: fileKey,
        // 上次的任务：服务端会核对名称与大小，匹配才复用
        uploadId: getUploadId(fileKey) || undefined,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.code !== 0) throw new Error((j && j.msg) || '初始化分片失败');
        uploadId = j.data.uploadId;
        saveUploadId(fileKey, uploadId);
        var total = j.data.total;
        var chunkSize = j.data.chunkSize;
        // 服务端已经收到哪些分片：续传时跳过它们
        var received = Array.isArray(j.data.received) ? j.data.received : [];
        var pending = [];
        for (var k = 0; k < total; k++) {
          if (received.indexOf(k) < 0) pending.push(k);
        }
        var sent = received.length;
        var stopped = false;
        var next = 0;
        var workers = Math.min(CHUNK_CONCURRENCY, Math.max(1, pending.length));
        var active = workers; // 仍在工作的分片任务数

        /** 分片上传的取消入口：停止派发新分片，并清掉服务端暂存 */
        item.chunkCancel = function () {
          if (stopped) return;
          stopped = true;
          // 任务即将被清理，指纹记录不再指向有效任务
          saveUploadId(fileKey, '');
          if (uploadId) {
            apiFetch(API + '/chunk/cancel?uploadId=' + encodeURIComponent(uploadId), { method: 'DELETE' }).catch(function () {});
          }
          toast('已取消上传：' + rel);
          ui.finish(false, '已取消', true);
        };

        /** 刷新百分比、速度与状态文案 */
        function updateProgress() {
          var pct = total ? Math.round((sent / total) * 100) : 0;
          ui.pctEl.textContent = pct + '%';
          ui.barEl.style.width = pct + '%';
          var elapsed = (Date.now() - startTime) / 1000;
          if (elapsed > 0) ui.speedEl.textContent = fmtSize((sent * chunkSize) / elapsed) + '/s';
          ui.statusEl.textContent = '分片上传中（' + sent + '/' + total + '）';
        }

        if (sent > 0) {
          ui.statusEl.textContent = '继续上传（已传 ' + sent + '/' + total + '）';
          updateProgress();
          toast('继续上传：' + rel + '（已完成 ' + sent + '/' + total + ' 个分片）', 'ok');
        } else {
          ui.statusEl.textContent = '分片上传中（0/' + total + '）';
        }

        /** 合并分片为正式文件 */
        function merge() {
          apiFetch(API + '/chunk/merge?uploadId=' + encodeURIComponent(uploadId), { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (mj) {
              if (!mj || mj.code !== 0) throw new Error((mj && mj.msg) || '分片合并失败');
              var saved = mj.data && mj.data.name ? mj.data.name : rel;
              var renamed = saved !== rel;
              // 任务已消费，指纹记录可以清掉了
              saveUploadId(fileKey, '');
              ownUploads[saved] = Date.now();
              toast(renamed ? '上传完成：' + rel + ' → ' + saved + '（同名已自动改名）' : '上传完成：' + rel, 'ok');
              waitForHighlight([saved]);
              ui.finish(true);
            })
            .catch(function (err) {
              ui.finish(false, err.message || '分片合并失败');
            });
        }

        function worker() {
          if (stopped) return;
          if (next >= pending.length) {
            // 所有分片都领完了，等最后一个任务结束再合并
            active -= 1;
            if (active === 0) merge();
            return;
          }
          var index = pending[next++];
          sendChunk(index, chunkSize)
            .then(function () {
              sent += 1;
              updateProgress();
              worker();
            })
            .catch(function (err) {
              stopped = true;
              ui.statusEl.textContent = '分片上传失败';
              // 清理服务端暂存的分片，避免残留占用磁盘
              if (uploadId) {
                apiFetch(API + '/chunk/cancel?uploadId=' + encodeURIComponent(uploadId), { method: 'DELETE' }).catch(function () {});
              }
              toast('上传失败：' + rel, 'err');
              ui.finish(false, err.message || '分片上传失败');
            });
        }

        for (var i = 0; i < workers; i++) worker();
      })
      .catch(function (err) {
        ui.statusEl.textContent = '分片上传失败';
        toast('上传失败：' + rel, 'err');
        ui.finish(false, err.message || '分片上传失败');
      });
  }

  /**
   * 传输测速：分别测量上传与下载速度。
   *
   * 上传方向把一段数据发给服务端并丢弃，下载方向从服务端拉一段固定数据，
   * 两者都按实际耗时换算成 MB/s，用来判断当前局域网链路质量。
   */
  function runSpeedTest() {
    var MB = 8;
    toast('正在测速…');
    var dlStart = Date.now();
    apiFetch(API + '/speed?size=' + MB)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var dlMs = Math.max(1, Date.now() - dlStart);
        var dlSpeed = buf.byteLength / 1024 / 1024 / (dlMs / 1000);
        var blob = new Blob([new Uint8Array(MB * 1024 * 1024)]);
        var upStart = Date.now();
        return apiFetch(API + '/speed', { method: 'POST', body: blob })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var upMs = Math.max(1, Date.now() - upStart);
            var upSpeed = (j.data && j.data.bytes ? j.data.bytes / 1024 / 1024 : MB) / (upMs / 1000);
            toast('测速完成：上传 ' + upSpeed.toFixed(1) + ' MB/s · 下载 ' + dlSpeed.toFixed(1) + ' MB/s', 'ok');
          });
      })
      .catch(function () {
        toast('测速失败，请稍后再试', 'err');
      });
  }

  function uploadOne(item, retryCount, onDone) {
    var file = item.file;
    var rel = item.rel || file.name;
    var fd;
    try {
      fd = new FormData();
      // 第三个参数指定 multipart 里的 filename，服务端据此保留目录结构
      fd.append('files', file, rel);
    } catch (err) {
      // 构造请求失败时必须正常收尾，否则队列的活跃计数不会释放，后续上传全部卡住
      toast('上传失败：' + rel, 'err');
      onDone(false);
      return;
    }
    var row = document.createElement('div');
    row.className = 'bg-slate-800/70 border border-slate-700 rounded-xl px-4 py-3';
    row.innerHTML =
      '<div class="flex items-center justify-between gap-3 mb-2">' +
        '<span class="text-xs truncate text-slate-300" title="' + escapeHtml(rel) + '">' + escapeHtml(rel) + '</span>' +
        '<span class="flex items-center gap-2 shrink-0">' +
          '<span class="text-xs text-emerald-400 font-mono" data-pct>0%</span>' +
          '<button type="button" data-cancel class="text-[10px] px-1.5 py-0.5 rounded border border-slate-600 text-slate-400 hover:text-red-400 hover:border-red-500/40 transition">取消</button>' +
        '</span>' +
      '</div>' +
      '<div class="h-1.5 bg-slate-700 rounded-full overflow-hidden">' +
        '<div class="h-full bg-emerald-500 transition-all duration-200" style="width:0%"></div>' +
      '</div>' +
      '<div class="flex justify-between mt-1.5 text-[10px] text-slate-500"><span data-status>等待上传…</span><span data-speed class="font-mono"></span></div>' +
      // 失败/取消后才出现：重试与关闭
      '<div class="hidden mt-2 items-center gap-2" data-actions>' +
        '<button type="button" data-retry class="text-[10px] px-2 py-1 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition">重试</button>' +
        '<button type="button" data-dismiss class="text-[10px] px-2 py-1 rounded border border-slate-600 text-slate-400 hover:bg-slate-700 transition">关闭</button>' +
      '</div>';
    $('uploadList').appendChild(row);
    var pctEl = row.querySelector('[data-pct]');
    var barEl = row.querySelector('.h-full');
    var statusEl = row.querySelector('[data-status]');
    var speedEl = row.querySelector('[data-speed]');
    var actionsEl = row.querySelector('[data-actions]');
    var cancelBtn = row.querySelector('[data-cancel]');
    var xhr = null;
    var finished = false;
    var canceled = false;

    /** 从「进行中」列表摘掉自己（失败重试时会重新加入） */
    function detach() {
      item.cancel = null;
      item.chunkCancel = null;
      var idx = activeItems.indexOf(item);
      if (idx >= 0) activeItems.splice(idx, 1);
    }

    /** 收尾：ok=成功，isCanceled=用户主动取消（不计入失败） */
    function finish(ok, msg, isCanceled) {
      if (finished) return;
      finished = true;
      detach();
      if (ok) barEl.style.width = '100%';
      barEl.className = 'h-full ' + (ok ? 'bg-emerald-500' : isCanceled ? 'bg-slate-500' : 'bg-red-500');
      statusEl.textContent = ok ? '上传完成' : msg || (isCanceled ? '已取消' : '上传失败');
      cancelBtn.classList.add('hidden');
      if (ok) {
        pctEl.textContent = '100%';
        setTimeout(function () { row.remove(); }, 1500);
      } else {
        // 失败 / 取消的行常驻，用户可重试或手动关闭（以前 6 秒就自动消失，看不到原因）
        actionsEl.classList.remove('hidden');
        actionsEl.classList.add('flex');
      }
      scheduleListReload();
      onDone(ok, !!isCanceled);
    }

    /** 取消这次上传 */
    function cancelUpload() {
      if (finished || canceled) return;
      canceled = true;
      statusEl.textContent = '已取消';
      // 分片上传自己负责停止派发并清理服务端暂存
      if (item.chunkCancel) {
        item.chunkCancel();
        return;
      }
      try {
        if (xhr) xhr.abort();
      } catch (e) {
        // 忽略取消失败：下面的 finish 仍会收尾
      }
      finish(false, '已取消', true);
    }

    /** 限流/网络错误后的退避重试：保持活跃计数，避免队列重新调度同一任务 */
    function retryLater(delay, label) {
      statusEl.textContent = label;
      barEl.className = 'h-full bg-amber-500';
      setTimeout(function () {
        if (canceled) return;
        // 让本次调用的闭包失效，避免和新的调用重复收尾
        finished = true;
        detach();
        row.remove();
        uploadOne(item, retryCount + 1, onDone);
      }, delay);
    }

    item.cancel = cancelUpload;
    activeItems.push(item);
    cancelBtn.addEventListener('click', cancelUpload);
    row.querySelector('[data-retry]').addEventListener('click', function () {
      row.remove();
      // rel 已经是最终路径（含目标目录），重试不要再补前缀
      enqueueUpload(file, rel, true);
      pumpQueue();
    });
    row.querySelector('[data-dismiss]').addEventListener('click', function () { row.remove(); });

    // 大文件改走分片并发上传，速度更快
    if (file.size >= CHUNK_THRESHOLD) {
      uploadByChunks(item, { pctEl: pctEl, barEl: barEl, statusEl: statusEl, speedEl: speedEl, finish: finish });
      return;
    }
    xhr = new XMLHttpRequest();
    // 目标目录由「上传到」决定；文件名里的子目录（上传文件夹）会拼在它后面
    var uploadUrl = API + '/upload';
    if (uploadTargetDir) uploadUrl += '?dir=' + encodeURIComponent(uploadTargetDir);
    xhr.open('POST', uploadUrl);
    // 上传需要访客以上权限，会话令牌随请求头带上
    if (sessionToken) xhr.setRequestHeader('X-Localsend-Session', sessionToken);
    var lastLoaded = 0;
    var lastTime = Date.now();
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.round(e.loaded / e.total * 100);
      pctEl.textContent = pct + '%';
      barEl.style.width = pct + '%';
      var now = Date.now();
      var dt = (now - lastTime) / 1000;
      if (dt > 0.3) {
        speedEl.textContent = fmtSize((e.loaded - lastLoaded) / dt) + '/s';
        lastLoaded = e.loaded;
        lastTime = now;
      }
    };
    xhr.onabort = function () { finish(false, '已取消', true); };
    xhr.onload = function () {
      var json = null;
      try { json = JSON.parse(xhr.responseText); } catch (e) { json = null; }
      if (xhr.status === 200 && json && json.code === 0) {
        // 服务端可能在同名时追加 _1 后缀，以返回的实际文件名为准
        var results = (json.data && json.data.results) || [];
        var saved = results.length ? results[0].name : rel;
        var renamed = saved !== rel;
        // 记录为本机上传，后续变更推送里不再重复提示
        ownUploads[saved] = Date.now();
        toast(renamed ? '上传完成：' + rel + ' → ' + saved + '（同名已自动改名）' : '上传完成：' + rel, 'ok');
        // 等待新文件出现在列表中，然后定位高亮
        waitForHighlight([saved]);
        finish(true);
        return;
      }
      var msg = (json && json.msg) || '上传失败';
      // 429 表示触发了并发/频率限制，退避后重试
      if (xhr.status === 429 && retryCount < MAX_RETRY) {
        retryLater(800 * Math.pow(2, retryCount), msg + '，重试中…');
        return;
      }
      toast(msg + '：' + rel, 'err');
      finish(false, msg);
    };
    xhr.onerror = function () {
      if (retryCount < MAX_RETRY) {
        retryLater(800 * Math.pow(2, retryCount), '网络错误，重试中…');
        return;
      }
      statusEl.textContent = '网络错误';
      toast('上传失败：' + rel, 'err');
      finish(false, '网络错误');
    };
    xhr.send(fd);
  }

  // 下载策略：文件大于 BLOB_LIMIT 时直接交给浏览器原生下载（流式写盘，不占用浏览器内存，
  // 避免大文件把内存撑爆导致下载失败）；小文件用 XHR 读成 blob，以便显示实时进度与速度
  var BLOB_LIMIT = 50 * 1024 * 1024; // 50MB

  function fileSizeOf(name) {
    for (var i = 0; i < fileItems.length; i++) {
      if (fileItems[i].name === name) return fileItems[i].size || 0;
    }
    return 0;
  }

  /** 用隐藏链接触发浏览器下载 */
  function triggerDownload(url, name) {
    var a = document.createElement('a');
    a.href = url;
    if (name) a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 0);
  }

  // 原生下载：由浏览器直接下载 URL，不经过 XHR，内存占用恒定
  function nativeDownload(name) {
    downloadUrl(name)
      .then(function (url) {
        triggerDownload(url, name);
      })
      .catch(function (e) { toast((e && e.message) || '下载失败', 'err'); });
  }

  // 小文件下载：XHR + blob，可显示进度
  function xhrDownload(name, onDone) {
    downloadUrl(name)
      .then(function (url) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.responseType = 'blob';
        var lastLoaded = 0;
        var lastTime = Date.now();
        xhr.onprogress = function (e) {
          if (!e.lengthComputable || !e.total) return;
          var pct = Math.round(e.loaded / e.total * 100);
          var now = Date.now();
          var dt = (now - lastTime) / 1000;
          if (dt > 0.3) {
            var speed = fmtSize((e.loaded - lastLoaded) / dt) + '/s';
            lastLoaded = e.loaded;
            lastTime = now;
            toast('下载中 ' + name + ' ' + pct + '% · ' + speed);
          }
        };
        xhr.onload = function () {
          if (xhr.status !== 200) {
            toast('下载失败：' + name, 'err');
            if (onDone) onDone(false);
            return;
          }
          var blob = xhr.response;
          var objectUrl = URL.createObjectURL(blob);
          triggerDownload(objectUrl, name);
          setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 5000);
          toast('下载完成：' + name, 'ok');
          if (onDone) onDone(true);
        };
        xhr.onerror = function () {
          toast('下载失败：' + name, 'err');
          if (onDone) onDone(false);
        };
        xhr.send();
      })
      .catch(function (e) {
        toast((e && e.message) || '下载失败', 'err');
        if (onDone) onDone(false);
      });
  }

  function downloadFile(name) {
    var size = fileSizeOf(name);
    // 支持 File System Access API 时，优先流式写入磁盘：内存恒定且能显示进度
    if (size > BLOB_LIMIT && canStreamToDisk()) {
      streamToDisk(name, size);
      return;
    }
    if (size > BLOB_LIMIT) {
      nativeDownload(name);
      toast('已转交浏览器下载：' + name + '（' + fmtSize(size) + '）', 'ok');
      return;
    }
    xhrDownload(name);
  }

  /** 浏览器是否支持 File System Access API */
  function canStreamToDisk() {
    return typeof window.showSaveFilePicker === 'function' && window.isSecureContext !== false;
  }

  /**
   * 大文件流式下载：让用户选择保存位置，边下边写盘。
   *
   * 全程使用 ReadableStream 直写磁盘，不在内存里缓存整个文件，
   * 因此内存占用恒定；同时可以实时反馈进度与速度。
   */
  function streamToDisk(name, size) {
    var progress = null;
    try {
      progress = showProgress('正在下载 ' + name);
    } catch (e) {
      progress = null;
    }
    var controller = new AbortController();
    if (progress) progress.cancel = function () { controller.abort(); };

    // 先让用户选择保存位置。
    // 这里必须在点击事件的同一个调用栈里发起（否则浏览器会判定失去用户手势），
    // 因此「换票据」放在拿到文件句柄之后再做。
    var picker = window.showSaveFilePicker({
      suggestedName: name,
      // 允许用户选择任意目录，避免默认下载目录被清理
      id: 'localsend-download',
    });
    Promise.resolve(picker)
      .then(function (handle) {
        return handle.createWritable().then(function (writer) {
          return downloadUrl(name).then(function (url) {
            return fetch(url, { signal: controller.signal }).then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status);
              var total = Number(res.headers.get('content-length')) || size || 0;
              var received = 0;
              var lastTime = Date.now();
              var lastLoaded = 0;
              var reader = res.body.getReader();
              function pump() {
                return reader.read().then(function (result) {
                  if (result.done) return writer.close();
                  received += result.value.length;
                  return writer.write(result.value).then(function () {
                    if (progress) {
                      var now = Date.now();
                      var dt = (now - lastTime) / 1000;
                      var speed = dt > 0 ? (received - lastLoaded) / dt : 0;
                      if (dt > 0.3) {
                        lastLoaded = received;
                        lastTime = now;
                        progress.update(received, total, speed);
                      }
                    }
                    return pump();
                  });
                });
              }
              return pump();
            });
          });
        });
      })
      .then(function () {
        if (progress) progress.done('下载完成：' + name, 'ok');
      })
      .catch(function (err) {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
          if (progress) progress.close();
          return;
        }
        // 直存失败时回退到浏览器原生下载
        if (progress) progress.close();
        nativeDownload(name);
        toast('直存失败，已转为浏览器下载：' + name, 'err');
      });
  }

  /**
   * 显示一个常驻的下载进度浮层，返回控制对象。
   */
  function showProgress(title) {
    var box = document.createElement('div');
    box.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] w-[min(92vw,420px)] bg-slate-900/95 border border-slate-700 rounded-2xl px-4 py-3 shadow-2xl';
    box.innerHTML =
      '<div class="flex items-center justify-between gap-3 mb-2">' +
        '<span class="text-xs text-slate-200 truncate" data-title></span>' +
        '<button class="text-[11px] text-slate-400 hover:text-red-400 shrink-0" data-cancel>取消</button>' +
      '</div>' +
      '<div class="h-1.5 bg-slate-700 rounded-full overflow-hidden">' +
        '<div class="h-full bg-emerald-500 transition-all duration-200" style="width:0%"></div>' +
      '</div>' +
      '<div class="flex justify-between mt-1.5 text-[10px] text-slate-500">' +
        '<span data-pct>0%</span><span data-speed class="font-mono"></span>' +
      '</div>';
    box.querySelector('[data-title]').textContent = title;
    document.body.appendChild(box);
    var bar = box.querySelector('.h-full');
    var pctEl = box.querySelector('[data-pct]');
    var speedEl = box.querySelector('[data-speed]');
    var cancelBtn = box.querySelector('[data-cancel]');
    cancelBtn.addEventListener('click', function () {
      if (progress.cancel) progress.cancel();
      progress.close();
    });
    return {
      update: function (received, total, speed) {
        var pct = total ? Math.round(received / total * 100) : 0;
        bar.style.width = pct + '%';
        pctEl.textContent = pct + '% · ' + fmtSize(received) + (total ? ' / ' + fmtSize(total) : '');
        speedEl.textContent = fmtSize(speed) + '/s';
      },
      done: function (msg, type) {
        bar.style.width = '100%';
        bar.className = 'h-full bg-emerald-500';
        progress.close();
        toast(msg, type);
      },
      close: function () { box.remove(); },
    };
  }

  /**
   * 批量下载：把选中的文件打包成 zip 下载。
   *
   * 打包在服务端流式完成，浏览器只接收一个 zip 流，内存占用恒定，
   * 不会因为文件多或文件大而失败。
   */
  function downloadZip(names) {
    var stamp = new Date();
    var p = function (x) { return String(x).padStart(2, '0'); };
    var fname = 'localsend-' + stamp.getFullYear() + p(stamp.getMonth() + 1) + p(stamp.getDate()) + '-' + p(stamp.getHours()) + p(stamp.getMinutes()) + '.zip';
    ticketUrl('zip', names, '/zip?names=' + encodeURIComponent(names.join(',')))
      .then(function (url) {
        triggerDownload(url, fname);
        toast('正在打包下载 ' + names.length + ' 个文件…', 'ok');
      })
      .catch(function (e) { toast((e && e.message) || '打包下载失败', 'err'); });
  }

  var imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'];
  var textExts = ['txt', 'md', 'json', 'js', 'ts', 'html', 'css', 'xml', 'log', 'csv', 'yml', 'yaml', 'ini', 'conf', 'sh', 'py', 'java', 'c', 'cpp', 'go', 'rs'];
  var videoExts = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'];
  var audioExts = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'];
  /** 文本预览的最大字符数，超过则截断 */
  var TEXT_PREVIEW_LIMIT = 200000;
  /** 内联预览的文件大小上限（字节），超过则改为新窗口打开 */
  var INLINE_PREVIEW_MAX = 100 * 1024 * 1024;

  /**
   * 预览文件。
   *
   * 图片、PDF、音视频直接在弹窗内联播放，文本以内联方式展示，
   * 其它类型回退为新窗口打开。
   */
  function previewFile(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var size = fileSizeOf(name);

    previewUrl(name)
      .then(function (url) {
        // 超出内联预览上限时直接新窗口打开，避免浏览器卡死
        if (size > INLINE_PREVIEW_MAX) {
          window.open(url, '_blank');
          toast('文件较大（' + fmtSize(size) + '），已在新窗口打开', 'ok');
          return;
        }

        if (imgExts.indexOf(ext) >= 0) {
          showMediaPreview(name, url, '<img src="' + url + '" alt="' + escapeHtml(name) + '" class="max-w-full max-h-[65vh] mx-auto rounded-lg" />');
          return;
        }
        if (ext === 'pdf') {
          showMediaPreview(name, url, '<iframe src="' + url + '" class="w-full h-[65vh] rounded-lg border border-slate-800 bg-slate-950"></iframe>');
          return;
        }
        if (videoExts.indexOf(ext) >= 0) {
          showMediaPreview(name, url, '<video src="' + url + '" controls class="max-w-full max-h-[65vh] mx-auto rounded-lg bg-slate-950"></video>');
          return;
        }
        if (audioExts.indexOf(ext) >= 0) {
          showMediaPreview(name, url, '<audio src="' + url + '" controls class="w-full"></audio>');
          return;
        }
        if (textExts.indexOf(ext) >= 0) {
          fetch(url)
            .then(function (r) { return r.text(); })
            .then(function (t) {
              $('previewModal').classList.remove('hidden');
              $('previewTitle').textContent = name;
              $('previewOpen').href = url;
              $('previewBody').classList.add('hidden');
              $('previewBody').innerHTML = '';
              var pre = $('previewContent');
              pre.classList.remove('hidden');
              var truncated = t.length > TEXT_PREVIEW_LIMIT;
              pre.textContent = truncated ? t.slice(0, TEXT_PREVIEW_LIMIT) + '\n\n... (内容过长已截断，共 ' + t.length + ' 字符)' : t;
              // 复制的是完整内容，截断只影响展示
              setPreviewCopy(t);
            })
            .catch(function () { toast('预览失败', 'err'); });
          return;
        }
        // 其它类型：尝试在弹窗内联，不行就新窗口打开
        window.open(url, '_blank');
      })
      .catch(function (e) { toast((e && e.message) || '预览失败', 'err'); });
  }

  /** 当前预览的文本内容，供「复制内容」按钮使用 */
  var previewText = '';

  /**
   * 设置预览弹窗里的复制按钮。
   *
   * 只有文本预览才有内容可复制，图片 / PDF / 音视频预览时传入空串隐藏按钮。
   */
  function setPreviewCopy(text) {
    previewText = text || '';
    var btn = $('previewCopy');
    if (!btn) return;
    if (previewText) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
  }

  /** 以媒体方式展示预览内容 */
  function showMediaPreview(name, url, html) {
    $('previewModal').classList.remove('hidden');
    $('previewTitle').textContent = name;
    $('previewOpen').href = url;
    $('previewContent').classList.add('hidden');
    $('previewContent').textContent = '';
    setPreviewCopy('');
    var body = $('previewBody');
    body.classList.remove('hidden');
    body.innerHTML = html;
  }

  /**
   * 创建一个分享链接（带时效，拿到链接的人无需登录即可访问）。
   *
   * 列表里的「复制」「扫码」都走这里。
   * 直接复制下载直链会把访问凭据一起带出去（以前还会带上会话令牌），
   * 分享链接才是「发给别人」的正确方式：可撤销、会过期、不影响自己的登录状态。
   */
  function createShare(names) {
    return apiFetch(API + '/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: names }),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) throw new Error(json.msg || '分享失败');
        refreshShareCount();
        return { url: location.origin + json.data.url, names: json.data.names, expiresAt: json.data.expiresAt };
      });
  }

  /** 生成分享链接并复制到剪贴板 */
  function shareFiles(names, label) {
    if (!names || !names.length) return Promise.resolve();
    return createShare(names)
      .then(function (share) {
        copyText(share.url);
        var tip = label || (share.names.length > 1 ? share.names.length + ' 个文件' : share.names[0]);
        toast('分享链接已复制（' + tip + '，24 小时内有效）', 'ok');
      })
      .catch(function (e) { toast((e && e.message) || '分享失败', 'err'); });
  }

  /** 生成分享链接并以二维码展示（手机扫码直接打开） */
  function shareQr(names) {
    if (!names || !names.length) return Promise.resolve();
    return createShare(names)
      .then(function (share) { showQr(share.url, '扫码打开分享：' + share.names.join('、')); })
      .catch(function (e) { toast((e && e.message) || '分享失败', 'err'); });
  }

  // ---------------------------------------------------------------------------
  // 剪贴板分享
  //
  // 分享原本只能分享「已经存在于存储目录里的文件」，
  // 想分享一段文字或一张截图得先手动存成文件。
  // 这里把剪贴板内容直接落盘成普通文件，再复用现成的分享接口生成链接。
  // ---------------------------------------------------------------------------

  /** 打开文本分享弹窗（可带初始文本） */
  function openTextModal(text) {
    $('textInput').value = text || '';
    // 与上传保持一致的落点：当前视图所在目录
    $('pasteDir').value = uploadTargetDir;
    $('textModal').classList.remove('hidden');
    setTimeout(function () { $('textInput').focus(); }, 60);
  }

  /** 关闭文本分享弹窗 */
  function closeTextModal() {
    $('textModal').classList.add('hidden');
  }

  /**
   * 把剪贴板内容落盘。
   *
   * kind 为 text 时 content 是文本本身，为 image 时是图片的 data URL。
   */
  function pasteToFile(payload, label) {
    // 自己粘贴的内容不再触发「收到新文件」提示
    suppressNotifyUntil = Date.now() + 2000;
    apiFetch(API + '/paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) { toast(json.msg || '保存失败', 'err'); return; }
        // 落盘后立刻生成分享链接，省去再选一次文件
        var tip = label ? label + '（' + json.data.name + '）' : json.data.name;
        if (json.data.reused) tip = '内容相同，已复用「' + json.data.name + '」';
        shareFiles([json.data.name], tip);
      })
      .catch(function () { toast('保存失败', 'err'); });
  }

  /** 分享剪贴板里的图片（截图） */
  function shareClipboardImage(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || '');
      if (!dataUrl) { toast('图片读取失败', 'err'); return; }
      pasteToFile({ kind: 'image', content: dataUrl }, '截图');
    };
    reader.onerror = function () { toast('图片读取失败', 'err'); };
    reader.readAsDataURL(file);
  }

  /** 从系统剪贴板读取内容（需要安全上下文与用户授权） */
  function readClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      toast('当前环境无法直接读取剪贴板，请改用 Ctrl+V 粘贴', 'err');
      return;
    }
    navigator.clipboard.read()
      .then(function (items) {
        // 优先取剪贴板里的图片
        for (var i = 0; i < items.length; i++) {
          if (items[i].types.indexOf('image/png') >= 0) {
            return items[i].getType('image/png').then(function (blob) {
              shareClipboardImage(blob);
            });
          }
        }
        if (navigator.clipboard.readText) {
          return navigator.clipboard.readText().then(function (text) {
            if (text && text.trim()) openTextModal(text);
            else toast('剪贴板是空的', 'err');
          });
        }
        return null;
      })
      .catch(function () { toast('无法读取剪贴板，请改用 Ctrl+V 粘贴', 'err'); });
  }

  /** 提交文本分享 */
  function submitTextShare() {
    var content = $('textInput').value;
    if (!content || !content.trim()) {
      toast('请输入要分享的内容', 'err');
      return;
    }
    var strategy = $('pasteStrategy').value;
    var payload = { kind: 'text', content: content, strategy: strategy };
    if (strategy === 'custom') {
      var name = $('pasteName').value.trim();
      if (!name) {
        toast('请填写自定义文件名', 'err');
        return;
      }
      payload.name = name;
    }
    var dir = $('pasteDir').value.trim();
    if (dir) payload.dir = dir;
    closeTextModal();
    pasteToFile(payload, '文本');
  }

  // ---------------------------------------------------------------------------
  // 分享管理
  //
  // 分享链接一旦发出去就很难收回，之前只能创建不能管理，
  // 这里把已创建的链接列出来，支持复制、看二维码与撤销。
  // ---------------------------------------------------------------------------

  /** 刷新分享数量角标 */
  function refreshShareCount() {
    apiFetch(API + '/share')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) return;
        var list = json.data || [];
        $('shareCount').textContent = list.length;
        $('shareCount').classList.toggle('hidden', list.length === 0);
      })
      .catch(function () { /* 角标失败不影响主流程 */ });
  }

  /** 打开分享管理弹窗 */
  function openShareModal() {
    $('shareModal').classList.remove('hidden');
    loadShareList();
  }

  /** 拉取并渲染分享列表 */
  function loadShareList() {
    apiFetch(API + '/share')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) { toast(json.msg || '加载失败', 'err'); return; }
        var list = json.data || [];
        var wrap = $('shareList');
        wrap.innerHTML = '';
        if (!list.length) {
          wrap.innerHTML = '<div class="px-3 py-8 text-center text-xs text-slate-500">还没有分享链接</div>';
          return;
        }
        list.forEach(function (item) {
          var url = location.origin + item.url;
          var left = Math.max(0, Math.round((item.expiresAt - Date.now()) / 60000));
          var expireText = left > 60 ? Math.round(left / 60) + ' 小时后' : left + ' 分钟后';
          var row = document.createElement('div');
          row.className = 'px-3 py-2 flex items-center gap-2 flex-wrap';
          row.innerHTML =
            '<div class="min-w-0 flex-1">' +
              '<div class="text-xs text-slate-200 truncate" title="' + escapeHtml(item.names.join('、')) + '">' + escapeHtml(item.names.join('、')) + '</div>' +
              '<div class="text-[11px] text-slate-500 mt-0.5">' + expireText + '失效 · 已访问 ' + item.hits + ' 次</div>' +
            '</div>' +
            '<div class="flex items-center gap-1 shrink-0">' +
              '<button data-act="copy" class="px-2 py-1 rounded text-[11px] text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/30 transition">复制</button>' +
              '<button data-act="qr" class="px-2 py-1 rounded text-[11px] text-slate-300 hover:bg-slate-700 border border-slate-600/60 transition">二维码</button>' +
              // 撤销分享属于危险操作，只有管理员可用
              (isAdmin() ? '<button data-act="revoke" class="px-2 py-1 rounded text-[11px] text-red-400 hover:bg-red-500/10 border border-red-500/30 transition">撤销</button>' : '') +
            '</div>';
          row.dataset.token = item.token;
          row.dataset.url = url;
          wrap.appendChild(row);
        });
      })
      .catch(function () { toast('加载分享列表失败', 'err'); });
  }

  /** 撤销一个分享链接 */
  function revokeShare(token) {
    apiFetch(API + '/share/' + encodeURIComponent(token), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) { toast(json.msg || '撤销失败', 'err'); return; }
        toast('分享链接已撤销', 'ok');
        loadShareList();
        refreshShareCount();
      })
      .catch(function () { toast('撤销失败', 'err'); });
  }

  function showQr(text, label) {
    $('qrModal').classList.remove('hidden');
    $('modalText').textContent = label || text;
    if (modalQrCode) {
      modalQrCode.update({ data: text });
    } else {
      $('modalQr').innerHTML = '';
      modalQrCode = new QRCodeStyling({
        width: 240, height: 240, type: 'canvas', data: text, margin: 0,
        dotsOptions: { type: 'rounded', color: '#10b981' },
        backgroundOptions: { color: '#ffffff' },
        cornersSquareOptions: { type: 'extra-rounded', color: '#10b981' },
        cornersDotOptions: { type: 'dot', color: '#10b981' },
      });
      modalQrCode.append($('modalQr'));
    }
  }
  /**
   * 浏览器是否支持系统分享。
   *
   * Web Share API 只在安全上下文（HTTPS 或 localhost）可用，
   * 局域网通过 IP + HTTP 访问时通常不可用，此时不显示按钮。
   */
  function canSystemShare() {
    if (typeof navigator.share !== 'function') return false;
    if (window.isSecureContext === false) return false;
    // 通过 IP 访问的局域网场景多半不是安全上下文
    var host = location.hostname;
    var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    return isLocal || window.isSecureContext === true;
  }

  /**
   * 调用系统分享（Web Share API）。
   *
   * 手机端可以把文件直接发到微信、AirDrop 等系统应用，
   * 比复制链接更顺手。浏览器不支持时回退为生成分享链接。
   */
  function systemShare(name) {
    if (typeof navigator.share !== 'function') {
      shareFiles([name]);
      return;
    }
    downloadUrl(name)
      .then(function (url) {
        // 能拿到文件本体时一并分享文件本身（移动端体验最好）
        return fetch(url)
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.blob();
          })
          .then(function (blob) {
            var file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
            return navigator.share({ files: [file], title: name, text: name });
          })
          .catch(function (err) {
            // 用户取消分享不算错误；其它错误回退为分享链接
            if (err && err.name === 'AbortError') return undefined;
            return createShare([name]).then(function (share) {
              return navigator.share({ title: name, text: name + '\n' + share.url }).catch(function () {});
            });
          });
      })
      .catch(function (e) { toast((e && e.message) || '系统分享失败', 'err'); });
  }

  function deleteFile(name) {
    if (!window.confirm('确定删除文件：' + name + ' ？（删除后可在回收站还原）')) return;
    apiFetch(API + '/delete/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) { toast(json.msg || '删除失败', 'err'); return; }
        // 文件已不存在，从选中列表里移除，避免后续批量操作报错
        delete selected[name];
        refreshAll();
        refreshTrashCount();
        // 提供撤销入口，误删可立即还原
        var entryId = json.data && json.data.id;
        if (entryId) {
          toast('已删除：' + name, 'ok', {
            label: '撤销',
            onClick: function () {
              restoreTrashEntry(entryId, function (ok, msg) {
                if (ok) toast('已还原：' + msg, 'ok');
                else toast(msg || '还原失败', 'err');
              });
            },
          });
        } else {
          toast('已删除：' + name, 'ok');
        }
      })
      .catch(function () { toast('删除失败', 'err'); });
  }

  /** 还原回收站中的某个条目 */
  function restoreTrashEntry(id, cb) {
    apiFetch(API + '/trash/' + encodeURIComponent(id) + '/restore', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) { if (cb) cb(false, json.msg || '还原失败'); return; }
        refreshAll();
        refreshTrashCount();
        if (cb) cb(true, json.data.name);
      })
      .catch(function () { if (cb) cb(false, '还原失败'); });
  }

  /** 刷新回收站条目数量 */
  function refreshTrashCount() {
    apiFetch(API + '/trash')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        var n = (json.data || []).length;
        var el = $('trashCount');
        if (n > 0) {
          el.textContent = n;
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      })
      .catch(function () { /* 忽略计数刷新失败 */ });
  }

  /** 打开回收站面板 */
  function openTrash() {
    $('trashModal').classList.remove('hidden');
    loadTrashList();
  }

  function loadTrashList() {
    var wrap = $('trashList');
    wrap.innerHTML = '<div class="text-xs text-slate-500 p-4 text-center">加载中…</div>';
    apiFetch(API + '/trash')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        var list = json.data || [];
        $('trashModalCount').textContent = '(' + list.length + ')';
        wrap.innerHTML = '';
        if (!list.length) {
          wrap.innerHTML = '<div class="text-xs text-slate-500 p-6 text-center">回收站是空的</div>';
          return;
        }
        list.forEach(function (item) {
          var div = document.createElement('div');
          div.className = 'flex items-center gap-3 px-3 py-2.5';
          div.innerHTML =
            '<span class="text-lg shrink-0">🗑</span>' +
            '<div class="min-w-0 flex-1">' +
              '<div class="text-xs truncate text-slate-200" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</div>' +
              '<div class="text-[10px] text-slate-500 mt-0.5">' + fmtSize(item.size || 0) + ' · 删除于 ' + fmtTime(item.deletedAt) + '</div>' +
            '</div>' +
            '<div class="flex items-center gap-1 shrink-0">' +
              // 还原与彻底删除属于危险操作，只有管理员可用
              (isAdmin()
                ? '<button data-act="restore" class="px-2 py-1 rounded text-xs text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/30 transition shrink-0">还原</button>' +
                  '<button data-act="purge" class="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-500/10 border border-red-500/30 transition shrink-0">彻底删除</button>'
                : '<span class="text-[11px] text-slate-500">只读</span>') +
            '</div>';
          var restoreBtn = div.querySelector('[data-act="restore"]');
          var purgeBtn = div.querySelector('[data-act="purge"]');
          if (restoreBtn) restoreBtn.addEventListener('click', function () {
            restoreTrashEntry(item.id, function (ok, msg) {
              if (ok) { toast('已还原：' + msg, 'ok'); loadTrashList(); }
              else toast(msg || '还原失败', 'err');
            });
          });
          if (purgeBtn) purgeBtn.addEventListener('click', function () {
            apiFetch(API + '/trash/' + encodeURIComponent(item.id), { method: 'DELETE' })
              .then(function (r) { return r.json(); })
              .then(function (j) {
                if (j.code !== 0) { toast(j.msg || '删除失败', 'err'); return; }
                toast('已彻底删除：' + item.name, 'ok');
                loadTrashList();
                refreshTrashCount();
              })
              .catch(function () { toast('删除失败', 'err'); });
          });
          wrap.appendChild(div);
        });
      })
      .catch(function () {
        wrap.innerHTML = '<div class="text-xs text-red-400 p-4 text-center">回收站加载失败</div>';
      });
  }

  // 事件绑定
  $('dropZone').addEventListener('click', function () { $('fileInput').click(); });
  // 移动端悬浮上传按钮
  $('fabUpload').addEventListener('click', function () { $('fileInput').click(); });
  $('dropZone').addEventListener('dragover', function (e) { e.preventDefault(); $('dropZone').classList.add('border-emerald-400'); });
  $('dropZone').addEventListener('dragleave', function () { $('dropZone').classList.remove('border-emerald-400'); });
  $('dropZone').addEventListener('drop', function (e) {
    e.preventDefault();
    $('dropZone').classList.remove('border-emerald-400');
    var dt = e.dataTransfer;
    if (!dt) return;
    // 拖入文件夹时浏览器只给出目录条目，需要递归展开后再上传
    var entries = [];
    if (dt.items) {
      Array.prototype.forEach.call(dt.items, function (it) {
        if (it.webkitGetAsEntry) {
          var en = it.webkitGetAsEntry();
          if (en) entries.push(en);
        }
      });
    }
    var hasDir = entries.some(function (en) { return en.isDirectory; });
    if (hasDir) {
      Promise.all(entries.map(function (en) { return readEntry(en, ''); })).then(function (parts) {
        var list = [];
        parts.forEach(function (arr) { list = list.concat(arr); });
        if (!list.length) {
          toast('拖入的文件夹里没有文件', 'err');
          return;
        }
        list.forEach(function (it) { enqueueUpload(it.file, it.rel); });
        pumpQueue();
        toast('正在上传文件夹，共 ' + list.length + ' 个文件');
      });
      return;
    }
    if (dt.files && dt.files.length) uploadFiles(dt.files);
  });
  $('fileInput').addEventListener('change', function (e) { uploadFiles(e.target.files); e.target.value = ''; });
  // 上传文件夹：保留原有目录结构
  $('pickDirBtn').addEventListener('click', function () { $('dirInput').click(); });
  // 监听本地目录，新增文件自动上传
  $('watchDirBtn').addEventListener('click', startWatchDir);
  $('dirInput').addEventListener('change', function (e) {
    var files = e.target.files;
    if (files && files.length) {
      uploadFiles(files);
      toast('正在上传文件夹，共 ' + files.length + ' 个文件');
    }
    e.target.value = '';
  });
  // 传输测速
  $('speedBtn').addEventListener('click', runSpeedTest);
  // 收件箱：只看最近收到的文件
  $('inboxBtn').addEventListener('click', function () {    inboxMode = !inboxMode;
    if (inboxMode) {
      inboxNewCount = 0;
      // 开启收件箱时顺带申请通知权限（用户主动点击，符合浏览器的授权要求）
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(function () {});
      }
    }
    currentPage = 1;
    updateInboxBadge();
    loadFiles();
    toast(inboxMode ? '已切换到收件箱（只看最近 ' + Math.round(INBOX_WINDOW / 60000) + ' 分钟收到的文件）' : '已退出收件箱');
  });
  // 按目录筛选（同时把上传目标切到该目录）
  $('dirSelect').addEventListener('change', function (e) {
    setDirFilter(e.target.value);
    loadFiles();
  });
  // 手动指定上传目标目录
  $('uploadDirSelect').addEventListener('change', function (e) {
    uploadTargetDir = e.target.value;
    toast('上传目标：' + (uploadTargetDir || '根目录'));
  });
  // 按扩展名筛选
  $('extSelect').addEventListener('change', function (e) {
    extFilter = e.target.value;
    currentPage = 1;
    loadFiles();
  });
  $('pageUrl').addEventListener('click', function () { window.open(pageUrl, '_blank'); });
  $('pageQrCard').addEventListener('click', function (e) {
    if (e.target.closest('button')) return; // 不拦截 openPageBtn
    showQr(pageUrl, '手机扫码访问页面');
  });
  $('sortSelect').addEventListener('change', function (e) {
    sortType = e.target.value;
    saveSortPref();
    currentPage = 1;
    loadFiles();
  });
  $('orderBtn').addEventListener('click', function () {
    sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    $('orderBtn').textContent = sortOrder === 'desc' ? '↓ 降序' : '↑ 升序';
    saveSortPref();
    currentPage = 1;
    loadFiles();
  });
  // 搜索过滤：输入即过滤，条件下推到服务端
  var searchTimer = null;
  $('searchInput').addEventListener('input', function (e) {
    var value = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      searchKeyword = value.trim();
      currentPage = 1;
      loadFiles();
    }, 250);
  });
  // 分页
  function gotoPage(page) {
    var target = Math.min(Math.max(1, page), totalPages);
    if (target === currentPage) return;
    currentPage = target;
    loadFiles();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $('firstPage').addEventListener('click', function () { gotoPage(1); });
  $('prevPage').addEventListener('click', function () { gotoPage(currentPage - 1); });
  $('nextPage').addEventListener('click', function () { gotoPage(currentPage + 1); });
  $('lastPage').addEventListener('click', function () { gotoPage(totalPages); });
  // 每页条数
  $('pageSizeSelect').addEventListener('change', function (e) {
    var size = Number(e.target.value);
    if (!size) return;
    PAGE_SIZE = size;
    savePageSizePref();
    currentPage = 1;
    loadFiles();
  });
  // 跳转到指定页码
  function jumpToPage() {
    var input = $('jumpInput');
    var page = Number(input.value);
    if (!page || page < 1) {
      toast('请输入有效的页码', 'err');
      return;
    }
    if (page > totalPages) {
      toast('最多只有 ' + totalPages + ' 页', 'err');
      return;
    }
    input.value = '';
    gotoPage(page);
  }
  $('jumpBtn').addEventListener('click', jumpToPage);
  $('jumpInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') jumpToPage();
  });
  $('closeModal').addEventListener('click', function () { $('qrModal').classList.add('hidden'); });
  $('qrModal').addEventListener('click', function (e) { if (e.target === $('qrModal')) $('qrModal').classList.add('hidden'); });

  // 重命名弹窗
  $('renameCancel').addEventListener('click', closeRenameDialog);
  $('renameOk').addEventListener('click', submitRename);
  $('renameModal').addEventListener('click', function (e) { if (e.target === $('renameModal')) closeRenameDialog(); });
  $('renameInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitRename();
  });

  // 移动弹窗
  $('moveCancel').addEventListener('click', closeMoveDialog);
  $('moveOk').addEventListener('click', submitMove);
  $('moveModal').addEventListener('click', function (e) { if (e.target === $('moveModal')) closeMoveDialog(); });
  $('moveDirList').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-dir]');
    if (!btn) return;
    // 根目录用空字符串表示
    $('moveDirInput').value = btn.dataset.dir || '';
  });

  // 批量重命名弹窗
  $('batchRenameCancel').addEventListener('click', closeBatchRenameDialog);
  $('batchRenameOk').addEventListener('click', submitBatchRename);
  $('batchRenameModal').addEventListener('click', function (e) { if (e.target === $('batchRenameModal')) closeBatchRenameDialog(); });
  $('batchRuleMode').addEventListener('change', renderRuleParams);
  $('batchRuleParams').addEventListener('input', updateRulePreview);
  $('batchRuleParams').addEventListener('change', updateRulePreview);

  // 粘贴内容分享
  $('pasteBtn').addEventListener('click', function () { openTextModal(''); });
  $('textCancel').addEventListener('click', closeTextModal);
  $('textOk').addEventListener('click', submitTextShare);
  $('textModal').addEventListener('click', function (e) { if (e.target === $('textModal')) closeTextModal(); });
  $('clipboardReadBtn').addEventListener('click', readClipboard);
  // 选择自定义命名时才显示文件名输入框
  $('pasteStrategy').addEventListener('change', function (e) {
    $('pasteName').classList.toggle('hidden', e.target.value !== 'custom');
  });
  // 在文本框里粘贴图片时按图片分享，普通文本走默认粘贴行为
  $('textInput').addEventListener('paste', function (e) {
    var dt = e.clipboardData || e.dataTransfer;
    if (!dt || !dt.items) return;
    for (var i = 0; i < dt.items.length; i++) {
      var item = dt.items[i];
      if (item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
        var file = item.getAsFile();
        if (file) {
          e.preventDefault();
          closeTextModal();
          shareClipboardImage(file);
          return;
        }
      }
    }
  });

  // 分享管理
  $('shareManageBtn').addEventListener('click', openShareModal);
  $('shareClose').addEventListener('click', function () { $('shareModal').classList.add('hidden'); });
  $('shareModal').addEventListener('click', function (e) { if (e.target === $('shareModal')) $('shareModal').classList.add('hidden'); });
  $('shareRefresh').addEventListener('click', loadShareList);
  $('shareList').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var row = btn.closest('div[data-token]');
    if (!row) return;
    if (btn.dataset.act === 'copy') copyText(row.dataset.url);
    else if (btn.dataset.act === 'qr') showQr(row.dataset.url, '扫码打开分享：' + (row.dataset.url || ''));
    else if (btn.dataset.act === 'revoke') revokeShare(row.dataset.token);
  });

  // ---------------------------------------------------------------------------
  // 设置面板
  //
  // 管理员可在网页端直接改口令、令牌与各项限制，改完立即生效。
  // 数值项按更易懂的单位显示（字节换算成 MB、毫秒换算成小时），
  // 提交时再换算回服务端使用的原始单位。
  // ---------------------------------------------------------------------------

  /** 设置项的分组与展示单位 */
  var SETTINGS_GROUPS = [
    { title: '访问控制', keys: ['token', 'password', 'visitorPassword', 'sessionTtl'] },
    { title: '传输限制', keys: ['maxSize', 'maxTotalSize', 'maxConcurrent', 'rateLimit'] },
    { title: '文件维护', keys: ['trashDays', 'autoCleanDays', 'autoCleanMaxSize', 'blockExtensions'] },
  ];

  /** 各设置项在界面上的单位换算 */
  var SETTINGS_UNITS = {
    maxSize: { factor: 1024 * 1024, label: 'MB' },
    maxTotalSize: { factor: 1024 * 1024, label: 'MB' },
    autoCleanMaxSize: { factor: 1024 * 1024, label: 'MB' },
    sessionTtl: { factor: 3600 * 1000, label: '小时' },
  };

  /** 设置面板当前的取值快照 */
  var settingsState = { items: [], restartRequired: [], file: '' };

  /** 取某个设置项 */
  function settingItem(key) {
    for (var i = 0; i < settingsState.items.length; i++) {
      if (settingsState.items[i].key === key) return settingsState.items[i];
    }
    return null;
  }

  /** 渲染单个设置项 */
  function renderSetting(item) {
    var head =
      '<div class="flex items-center justify-between gap-2">' +
        '<div class="text-slate-200 font-medium">' + escapeHtml(item.label) +
          (item.set ? '<span class="ml-1 text-[10px] text-emerald-400">已启用</span>' : '<span class="ml-1 text-[10px] text-slate-500">未启用</span>') +
          (item.source === 'runtime' ? '<span class="ml-1 text-[10px] text-sky-400">运行时</span>' : '') +
        '</div>' +
        (item.source === 'runtime'
          ? '<button data-reset="' + item.key + '" class="text-[11px] text-slate-400 hover:text-emerald-400 px-2 py-1 rounded border border-slate-700 transition shrink-0">恢复默认</button>'
          : '') +
      '</div>';

    var input = '';
    if (item.kind === 'secret') {
      // 敏感项不显示原文，只提示当前状态；留空表示不修改
      input =
        '<input data-key="' + item.key + '" type="password" placeholder="' + (item.set ? '已设置（' + escapeHtml(item.masked || '') + '），留空表示不修改' : '留空表示不修改') + '" ' +
        'autocomplete="new-password" spellcheck="false" class="mt-2 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs outline-none focus:border-emerald-500/60" />' +
        (item.set
          ? '<button data-clear="' + item.key + '" class="mt-1 text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-500/30 transition">清除（停用该项）</button>'
          : '');
    } else if (item.kind === 'rate') {
      var rate = item.value || { windowMs: 60000, max: 120 };
      input =
        '<div class="mt-2 flex items-center gap-2 flex-wrap">' +
          '<input data-key="rateLimit.windowMs" type="number" min="1" value="' + Math.round((rate.windowMs || 60000) / 1000) + '" ' +
            'class="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-500/60" />' +
          '<span class="text-[11px] text-slate-500">秒内最多</span>' +
          '<input data-key="rateLimit.max" type="number" min="0" value="' + Number(rate.max ?? 120) + '" ' +
            'class="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-500/60" />' +
          '<span class="text-[11px] text-slate-500">次请求（0 表示不限制）</span>' +
        '</div>';
    } else if (item.kind === 'numberList') {
      input =
        '<input data-key="' + item.key + '" type="text" value="' + escapeHtml((item.value || []).join(', ')) + '" ' +
        'placeholder="如 .php, .sh" spellcheck="false" class="mt-2 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs outline-none focus:border-emerald-500/60" />';
    } else {
      var unit = SETTINGS_UNITS[item.key];
      var shown = Number(item.value ?? 0);
      if (unit) shown = Math.round((shown / unit.factor) * 100) / 100;
      input =
        '<div class="mt-2 flex items-center gap-2">' +
          '<input data-key="' + item.key + '" type="number" min="0" value="' + shown + '" ' +
            'class="w-28 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-500/60" />' +
          (unit ? '<span class="text-[11px] text-slate-500">' + unit.label + '</span>' : '') +
          (item.unit && !unit ? '<span class="text-[11px] text-slate-500">' + escapeHtml(item.unit) + '</span>' : '') +
        '</div>';
    }

    return '<div class="bg-slate-800/40 border border-slate-800 rounded-xl p-3">' + head + input +
      '<div class="text-[11px] text-slate-500 mt-1.5">' + escapeHtml(item.desc) + '</div></div>';
  }

  /** 当前页面是否从回环地址打开（本机浏览器） */
  function isLoopbackClient() {
    var host = location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  }

  /** 打开设置面板 */
  function openSettings() {
    apiFetch(API + '/settings')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) { toast(json.msg || '读取设置失败', 'err'); return; }
        settingsState = json.data || settingsState;
        var body = $('settingsBody');
        var html = '';
        SETTINGS_GROUPS.forEach(function (group) {
          var items = group.keys.map(settingItem).filter(Boolean);
          if (!items.length) return;
          html += '<div><div class="text-[11px] text-slate-400 mb-1.5">' + group.title + '</div><div class="space-y-2">' +
            items.map(renderSetting).join('') + '</div></div>';
        });
        // 这两项与路由注册、存储路径有关，只能改配置文件后重启
        if (settingsState.restartRequired && settingsState.restartRequired.length) {
          html += '<div><div class="text-[11px] text-slate-400 mb-1.5">需重启服务才能生效</div><div class="space-y-2">' +
            settingsState.restartRequired.map(function (item) {
              return '<div class="bg-slate-800/40 border border-slate-800 rounded-xl p-3">' +
                '<div class="flex items-center justify-between gap-2"><div class="text-slate-200 font-medium">' + escapeHtml(item.label) + '</div>' +
                '<span class="text-[10px] text-amber-400">仅配置文件可改</span></div>' +
                '<div class="text-[11px] text-slate-500 mt-1.5 font-mono break-all">' + escapeHtml(String(item.value)) + '</div></div>';
            }).join('') + '</div></div>';
        }
        if (settingsState.file) {
          html += '<div class="text-[11px] text-slate-500">运行时设置保存在：<span class="font-mono break-all">' +
            escapeHtml(settingsState.file) + '</span></div>';
        }
        body.innerHTML = html;
        // 开放模式下服务端只接受本机发起的写入：非本机时提前说明，不让用户白填一遍
        var remoteOpen = !!sessionInfo.open && !isLoopbackClient();
        $('settingsLocalHint').classList.toggle('hidden', !remoteOpen);
        $('settingsSave').disabled = remoteOpen;
        $('settingsSave').title = remoteOpen ? '开放模式下只能在运行服务的本机修改设置' : '';
        $('settingsModal').classList.remove('hidden');
      })
      .catch(function () { toast('读取设置失败', 'err'); });
  }

  /** 收集面板里改动过的项 */
  function collectSettingChanges() {
    var changes = {};
    var rate = null;
    var nodes = $('settingsBody').querySelectorAll('[data-key]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.dataset.key;
      // 只提交用户动过的输入框
      if (el.dataset.touched !== '1') continue;
      var raw = el.value;
      if (el.type === 'password' && !raw) continue; // 敏感项留空表示不修改
      if (key.indexOf('rateLimit.') === 0) {
        if (!rate) rate = {};
        var field = key.slice('rateLimit.'.length);
        var num = Number(raw);
        rate[field] = field === 'windowMs' ? num * 1000 : num;
        continue;
      }
      if (el.type === 'number') {
        changes[key] = Number(raw);
        continue;
      }
      if (key === 'blockExtensions') {
        changes[key] = raw;
        continue;
      }
      changes[key] = raw;
    }
    if (rate) changes.rateLimit = rate;
    return changes;
  }

  /** 保存设置 */
  function saveSettings() {
    // 开放模式 + 非本机：服务端会拒绝，这里先给出明确原因
    if (sessionInfo.open && !isLoopbackClient()) {
      toast('尚未设置口令，请在本机浏览器修改设置，或在配置文件里设置 password', 'err');
      return;
    }
    var changes = collectSettingChanges();
    if (!Object.keys(changes).length) {
      toast('没有需要保存的修改', 'err');
      return;
    }
    var payload = { changes: changes };
    // 当前管理员口令：明文只留在浏览器里，提交的是它的摘要
    var currentPwd = $('settingsCurrentPwd').value;
    if ('password' in changes || 'visitorPassword' in changes) {
      if (!currentPwd) {
        toast('修改口令需要填写当前管理员口令', 'err');
        return;
      }
    }
    // 先把要提交的摘要算出来（需要服务端公开的盐值）
    var prepare = function () {
      if (!('password' in changes) && !('visitorPassword' in changes)) return Promise.resolve();
      return fetchSalts()
        .then(function (salts) {
          payload.currentPasswordDigest = digestOf(salts, 'password', currentPwd);
          if (!payload.currentPasswordDigest) throw new Error('服务端未启用管理员口令');
        });
    };
    prepare()
      .then(function () {
        return apiFetch(API + '/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) { toast(json.msg || '保存失败', 'err'); return; }
        toast('设置已保存并生效', 'ok');
        $('settingsCurrentPwd').value = '';
        // 令牌变了：用新令牌换一个会话，否则旧会话会失效
        if ('token' in changes) {
          var newToken = String(changes.token || '');
          accessToken = newToken;
          try { localStorage.setItem(TOKEN_STORAGE_KEY, newToken); } catch (e) { /* 忽略存储失败 */ }
          toast(newToken ? '访问令牌已更新，旧令牌随即失效' : '访问令牌已停用，访问不再需要令牌', 'ok');
          if (newToken) {
            exchangeToken(newToken).catch(function () {
              openLoginModal('请重新输入口令或访问令牌');
            });
          }
        }
        openSettings();
      })
      .catch(function (e) {
        toast((e && e.message) || '保存失败', 'err');
      });
  }

  /** 恢复某一项的默认值 */
  function resetSetting(key) {
    if (sessionInfo.open && !isLoopbackClient()) {
      toast('尚未设置口令，请在本机浏览器修改设置', 'err');
      return;
    }
    apiFetch(API + '/settings/' + encodeURIComponent(key), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) { toast(json.msg || '恢复失败', 'err'); return; }
        toast('已恢复默认设置', 'ok');
        openSettings();
      })
      .catch(function () { toast('恢复失败', 'err'); });
  }

  /** 事件绑定
   * 登录与退出
   */
  $('loginBtn').addEventListener('click', function () { openLoginModal(''); });
  $('logoutBtn').addEventListener('click', logout);
  $('loginCancel').addEventListener('click', closeLoginModal);
  $('loginOk').addEventListener('click', submitLogin);
  $('loginModal').addEventListener('click', function (e) { if (e.target === $('loginModal')) closeLoginModal(); });
  $('loginPassword').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitLogin();
  });

  // 设置面板
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', function () { $('settingsModal').classList.add('hidden'); });
  $('settingsModal').addEventListener('click', function (e) { if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden'); });
  $('settingsSave').addEventListener('click', saveSettings);
  $('settingsCopyLink').addEventListener('click', function () { copyText(pageUrl); });
  // 记录哪些输入框被改过，只提交改动过的项
  $('settingsBody').addEventListener('input', function (e) {
    var el = e.target;
    if (el && el.dataset && el.dataset.key) el.dataset.touched = '1';
  });
  // 恢复默认 / 清除某一项
  $('settingsBody').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-reset], button[data-clear]');
    if (!btn) return;
    if (btn.dataset.reset) {
      if (!window.confirm('确定恢复该项的默认值？')) return;
      resetSetting(btn.dataset.reset);
      return;
    }
    if (btn.dataset.clear) {
      if (!window.confirm('确定停用该项？停用后该项将回到配置文件的取值。')) return;
      resetSetting(btn.dataset.clear);
    }
  });

  // 页面任意处直接粘贴（Ctrl+V）即可分享文本或截图
  document.addEventListener('paste', function (e) {
    var target = e.target;
    // 在输入框 / 文本域里粘贴时保持默认行为
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    var dt = e.clipboardData || e.dataTransfer;
    if (!dt) return;
    // 需要访客口令时不能保存内容，先提示并引导登录
    if (!canWrite()) {
      toast('需要访客口令才能保存粘贴的内容', 'err', {
        label: '登录',
        onClick: function () { openLoginModal('请输入访客口令后即可上传与分享'); },
      });
      return;
    }
    // 图片（截图）优先
    if (dt.items && dt.items.length) {
      for (var i = 0; i < dt.items.length; i++) {
        var item = dt.items[i];
        if (item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
          var file = item.getAsFile();
          if (file) {
            e.preventDefault();
            shareClipboardImage(file);
            return;
          }
        }
      }
    }
    var text = dt.getData('text/plain');
    if (text && text.trim()) {
      e.preventDefault();
      openTextModal(text);
    }
  });
  function closePreviewModal() {
    $('previewModal').classList.add('hidden');
    // 清空媒体内容，避免残留的音视频继续在后台播放
    var body = $('previewBody');
    body.innerHTML = '';
    body.classList.add('hidden');
    $('previewContent').textContent = '';
    $('previewContent').classList.add('hidden');
    setPreviewCopy('');
  }
  $('closePreview').addEventListener('click', closePreviewModal);
  $('previewModal').addEventListener('click', function (e) { if (e.target === $('previewModal')) closePreviewModal(); });
  // 复制预览内容：文本预览时才可用
  $('previewCopy').addEventListener('click', function () {
    if (!previewText) return;
    copyText(previewText);
  });
  // 回收站
  $('trashBtn').addEventListener('click', openTrash);
  $('closeTrash').addEventListener('click', function () { $('trashModal').classList.add('hidden'); });
  $('trashModal').addEventListener('click', function (e) { if (e.target === $('trashModal')) $('trashModal').classList.add('hidden'); });
  $('trashEmpty').addEventListener('click', function () {
    if (!window.confirm('确定清空回收站？其中的文件将无法还原。')) return;
    apiFetch(API + '/trash', { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.code !== 0) { toast(j.msg || '清空失败', 'err'); return; }
        toast('已清空回收站（' + j.data.removed + ' 项）', 'ok');
        loadTrashList();
        refreshTrashCount();
      })
      .catch(function () { toast('清空失败', 'err'); });
  });
  $('fileList').addEventListener('click', function (e) {
    // 点击文件名前的目录标记：只看该目录下的文件
    var dirEl = e.target.closest('[data-dir]');
    if (dirEl) {
      setDirFilter(dirFilter === dirEl.dataset.dir ? '' : dirEl.dataset.dir);
      // 同步目录筛选下拉，避免两处状态不一致
      $('dirSelect').value = dirFilter;
      loadFiles();
      return;
    }
    var btnEl = e.target.closest('button[data-act]');
    if (!btnEl) return;
    var name = btnEl.dataset.name;
    var act = btnEl.dataset.act;
    if (act === 'download') downloadFile(name);
    else if (act === 'preview') previewFile(name);
    else if (act === 'share') shareFiles([name]);
    else if (act === 'syshare') systemShare(name);
    else if (act === 'qr') shareQr([name]);
    else if (act === 'rename') openRenameDialog(name);
    else if (act === 'move') openMoveDialog([name]);
    else if (act === 'delete') deleteFile(name);
  });

  // 全选 / 批量操作（全选范围为当前页显示的文件）
  $('selectAll').addEventListener('change', function (e) {
    var checked = e.target.checked;
    currentPageItems().forEach(function (f) { selected[f.name] = checked; });
    updateBatchUI();
    document.querySelectorAll('#fileList input.file-check').forEach(function (cb) { cb.checked = checked; });
    document.querySelectorAll('#fileList > div').forEach(function (div) {
      div.classList.toggle('bg-slate-800/40', checked);
    });
  });
  $('fileList').addEventListener('change', function (e) {
    if (!e.target.classList.contains('file-check')) return;
    var name = e.target.dataset.name;
    selected[name] = e.target.checked;
    updateBatchUI();
    e.target.closest('div').classList.toggle('bg-slate-800/40', e.target.checked);
  });
  $('batchShare').addEventListener('click', function () {
    var names = Object.keys(selected).filter(function (n) { return selected[n]; });
    if (!names.length) return;
    shareFiles(names);
  });
  $('batchDownload').addEventListener('click', function () {
    var names = Object.keys(selected).filter(function (n) { return selected[n]; });
    if (!names.length) return;
    // 多个文件打成一个 zip 由服务端流式打包，浏览器只需下载一次
    if (names.length === 1) {
      downloadFile(names[0]);
      return;
    }
    downloadZip(names);
  });
  // 批量移动到目录
  $('batchMove').addEventListener('click', function () {
    var names = Object.keys(selected).filter(function (n) { return selected[n]; });
    if (!names.length) return;
    openMoveDialog(names);
  });
  // 批量重命名
  $('batchRename').addEventListener('click', function () {
    var names = Object.keys(selected).filter(function (n) { return selected[n]; });
    if (!names.length) return;
    openBatchRenameDialog(names);
  });
  $('batchDelete').addEventListener('click', function () {
    var names = Object.keys(selected).filter(function (n) { return selected[n]; });
    if (!names.length) return;
    if (!window.confirm('确定删除选中的 ' + names.length + ' 个文件？删除后可在回收站还原。')) return;
    toast('正在删除 ' + names.length + ' 个文件');
    var total = names.length;
    var done = 0;
    var failed = 0;
    // 记录成功删除的条目 ID，供撤销使用
    var trashIds = [];
    function next() {
      if (done >= total) {
        selected = {};
        refreshAll();
        refreshTrashCount();
        if (failed) {
          toast('已完成 ' + (total - failed) + '/' + total + '，' + failed + ' 个失败', 'err');
        } else if (trashIds.length) {
          toast('已删除 ' + total + ' 个文件', 'ok', {
            label: '撤销',
            onClick: function () { restoreAll(trashIds); },
          });
        } else {
          toast('已删除 ' + total + ' 个文件', 'ok');
        }
        return;
      }
      apiFetch(API + '/delete/' + encodeURIComponent(names[done]), { method: 'DELETE' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.code !== 0) failed++;
          else if (j.data && j.data.id) trashIds.push(j.data.id);
          done++;
          next();
        })
        .catch(function () { failed++; done++; next(); });
    }
    next();
  });

  /** 依次还原多个回收站条目 */
  function restoreAll(ids) {
    if (!ids || !ids.length) return;
    var i = 0;
    var ok = 0;
    var failed = 0;
    function next() {
      if (i >= ids.length) {
        refreshAll();
        refreshTrashCount();
        if (failed) toast('已还原 ' + ok + '/' + ids.length + '，' + failed + ' 个失败', 'err');
        else toast('已还原 ' + ok + ' 个文件', 'ok');
        return;
      }
      restoreTrashEntry(ids[i], function (success) {
        if (success) ok++; else failed++;
        i++;
        next();
      });
    }
    next();
  }

  // 恢复上次选择的排序方式与升降序
  $('sortSelect').value = sortType;
  $('orderBtn').textContent = sortOrder === 'desc' ? '↓ 降序' : '↑ 升序';
  $('pageSizeSelect').value = String(PAGE_SIZE);

  /**
   * 身份确认之后，开始加载数据并订阅事件。
   *
   * 需要访问令牌时先不加载：否则一堆接口都会拿到 401，
   * 事件流也会自动重连，很快就把频率限制打满。
   */
  function startApp() {
    // 认证还没恢复时不要拉数据、不要订阅事件
    if (authBlocked) return;
    loadFiles();
    applyRole();
    loadFacets();
    refreshTrashCount();
    refreshShareCount();
    updateInboxBadge();
    connectEvents();
  }

  // 认证失败由统一流程处理（提示重新认证 + 停止一切请求），
  // 这里把未被接住的认证失败吞掉，避免控制台反复报红
  window.addEventListener('unhandledrejection', function (e) {
    if (e.reason && e.reason.authFailed) e.preventDefault();
  });

  // 先取身份再渲染列表，保证按钮的显示与当前权限一致
  refreshSession().then(function (ok) {
    if (ok) startApp();
  });
  // 候选访问地址与二维码：独立于认证，页面一打开就准备好
  loadNetworkInfo();

  // 注册 Service Worker，提供离线可用的页面外壳
  // 仅在安全上下文可用（https 或 localhost）；局域网 http 下浏览器会拒绝注册
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () {
      var swUrl = '/localsend/sw.js';
      navigator.serviceWorker.register(swUrl).catch(function () {
        // 注册失败不影响正常使用，静默忽略
      });
    });
  }
})();

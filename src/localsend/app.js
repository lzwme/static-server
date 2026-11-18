(function () {
  'use strict';
  var API = '/localsend/api';
  var $ = function (id) { return document.getElementById(id); };
  // 访问令牌（服务端配置 token 时，访问地址需带 ?key=xxx）
  var KEY = new URLSearchParams(location.search).get('key') || '';
  function withKey(url) {
    if (!KEY) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(KEY);
  }
  var pageUrl = location.origin + location.pathname + (KEY ? '?key=' + encodeURIComponent(KEY) : '');
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
    fetch(withKey(API + '/preview/' + encodeURIComponent(name)))
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
    return fetch(withKey(API + '/list?' + buildListQuery()))
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
    fetch(withKey(API + '/rename'), {
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
    fetch(withKey(API + '/move'), {
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
    fetch(withKey(API + '/rename-batch'), {
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

  /** 订阅服务端文件变更事件 */
  function connectEvents() {
    if (!window.EventSource) return;
    try {
      eventSource = new EventSource(withKey(API + '/events'));
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
    // 连接断开时浏览器会自动按 retry 重连，这里无需额外处理
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
    return fetch(withKey(API + '/facets'))
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

  /** 文件变动后同时刷新列表与筛选选项 */
  function refreshAll() {
    loadFiles();
    loadFacets();
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
          btn('预览', 'preview', false, '👁') + btn('下载', 'download', false, '⬇️') + btn('分享', 'share', false, '🔗') +
          (canSystemShare() ? btn('系统分享', 'syshare', false, '📤') : '') +
          btn('复制', 'copy', false, '📋') + btn('扫码', 'qr', false, '📱') +
          btn('重命名', 'rename', false, '✏️') + btn('移动', 'move', false, '📂') + btn('删除', 'delete', true, '🗑') +
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
  var uploadQueue = []; // 待上传的文件
  var uploadActive = 0; // 当前进行中的上传数
  var uploadDone = 0; // 已完成（含失败）的数量
  var uploadFailed = 0; // 失败数量
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
      (uploadFailed ? '<span class="text-red-400 font-mono">' + uploadFailed + '</span><span class="text-slate-400">失败</span>' : '');
  }

  function enqueueUpload(file, rel) {
    uploadQueue.push({ file: file, rel: rel || file.name });
    uploadTotal += 1;
    updateQueueSummary();
  }

  /** 从队列中取出下一个文件开始上传 */
  function pumpQueue() {
    while (uploadActive < UPLOAD_CONCURRENCY && uploadQueue.length) {
      var item = uploadQueue.shift();
      uploadActive += 1;
      uploadOne(item, 0, function (ok) {
        uploadActive -= 1;
        uploadDone += 1;
        if (!ok) uploadFailed += 1;
        updateQueueSummary();
        if (uploadDone >= uploadTotal) {
          // 本批次结束
          uploadQueue = [];
          uploadTotal = 0;
          uploadDone = 0;
          uploadFailed = 0;
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
   * 大文件分片并发上传。
   *
   * 单条 HTTP 流在弱网下容易成为瓶颈，把文件切片后并发上传可以让多条流同时传输，
   * 局域网内大文件的速度提升明显。分片接口服务端已经实现，这里只负责调度。
   */
  function uploadByChunks(item, ui) {
    var file = item.file;
    var rel = item.rel || file.name;
    var startTime = Date.now();
    var uploadId = '';

    /** 上传单个分片，遇到并发限流时退避重试 */
    function sendChunk(index, chunkSize) {
      var start = index * chunkSize;
      var blob = file.slice(start, Math.min(start + chunkSize, file.size));
      var fd = new FormData();
      fd.append('chunk', blob, 'chunk-' + index);
      var attempt = 0;
      function once() {
        return fetch(withKey(API + '/chunk/upload?uploadId=' + encodeURIComponent(uploadId) + '&index=' + index), { method: 'POST', body: fd })
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

    fetch(withKey(API + '/chunk/init'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: rel, size: file.size, chunkSize: CHUNK_SIZE }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.code !== 0) throw new Error((j && j.msg) || '初始化分片失败');
        uploadId = j.data.uploadId;
        var total = j.data.total;
        var chunkSize = j.data.chunkSize;
        var sent = 0;
        var stopped = false;
        var next = 0;
        var active = CHUNK_CONCURRENCY; // 仍在工作的分片任务数
        ui.statusEl.textContent = '分片上传中（0/' + total + '）';

        /** 合并分片为正式文件 */
        function merge() {
          fetch(withKey(API + '/chunk/merge?uploadId=' + encodeURIComponent(uploadId)), { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (mj) {
              if (!mj || mj.code !== 0) throw new Error((mj && mj.msg) || '分片合并失败');
              var saved = mj.data && mj.data.name ? mj.data.name : rel;
              var renamed = saved !== rel;
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
          if (next >= total) {
            // 所有分片都领完了，等最后一个任务结束再合并
            active -= 1;
            if (active === 0) merge();
            return;
          }
          var index = next++;
          sendChunk(index, chunkSize)
            .then(function () {
              sent += 1;
              var pct = Math.round((sent / total) * 100);
              ui.pctEl.textContent = pct + '%';
              ui.barEl.style.width = pct + '%';
              var elapsed = (Date.now() - startTime) / 1000;
              if (elapsed > 0) ui.speedEl.textContent = fmtSize((sent * chunkSize) / elapsed) + '/s';
              ui.statusEl.textContent = '分片上传中（' + sent + '/' + total + '）';
              worker();
            })
            .catch(function (err) {
              stopped = true;
              ui.statusEl.textContent = '分片上传失败';
              // 清理服务端暂存的分片，避免残留占用磁盘
              if (uploadId) {
                fetch(withKey(API + '/chunk/cancel?uploadId=' + encodeURIComponent(uploadId)), { method: 'DELETE' }).catch(function () {});
              }
              toast('上传失败：' + rel, 'err');
              ui.finish(false, err.message || '分片上传失败');
            });
        }

        for (var i = 0; i < CHUNK_CONCURRENCY; i++) worker();
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
    fetch(withKey(API + '/speed?size=' + MB))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var dlMs = Math.max(1, Date.now() - dlStart);
        var dlSpeed = buf.byteLength / 1024 / 1024 / (dlMs / 1000);
        var blob = new Blob([new Uint8Array(MB * 1024 * 1024)]);
        var upStart = Date.now();
        return fetch(withKey(API + '/speed'), { method: 'POST', body: blob })
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
        '<span class="text-xs text-emerald-400 shrink-0 font-mono" data-pct>0%</span>' +
      '</div>' +
      '<div class="h-1.5 bg-slate-700 rounded-full overflow-hidden">' +
        '<div class="h-full bg-emerald-500 transition-all duration-200" style="width:0%"></div>' +
      '</div>' +
      '<div class="flex justify-between mt-1.5 text-[10px] text-slate-500"><span data-status>等待上传…</span><span data-speed class="font-mono"></span></div>';
    $('uploadList').appendChild(row);
    var pctEl = row.querySelector('[data-pct]');
    var barEl = row.querySelector('.h-full');
    var statusEl = row.querySelector('[data-status]');
    var speedEl = row.querySelector('[data-speed]');
    // 大文件改走分片并发上传，速度更快
    if (file.size >= CHUNK_THRESHOLD) {
      uploadByChunks(item, { pctEl: pctEl, barEl: barEl, statusEl: statusEl, speedEl: speedEl, finish: finish });
      return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', withKey(API + '/upload'));
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
    var finished = false;
    function finish(ok, msg) {
      if (finished) return;
      finished = true;
      barEl.style.width = ok ? '100%' : barEl.style.width;
      barEl.className = 'h-full ' + (ok ? 'bg-emerald-500' : 'bg-red-500');
      statusEl.textContent = ok ? '上传完成' : msg || '上传失败';
      if (ok) {
        pctEl.textContent = '100%';
        setTimeout(function () { row.remove(); }, 1500);
      } else {
        // 失败的任务保留在列表里，便于用户查看原因
        setTimeout(function () { row.remove(); }, 6000);
      }
      scheduleListReload();
      onDone(ok);
    }
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
        statusEl.textContent = msg + '，重试中…';
        barEl.className = 'h-full bg-amber-500';
        var delay = 800 * Math.pow(2, retryCount);
        setTimeout(function () {
          row.remove();
          // 重试期间保持活跃计数不变，避免队列在此期间调度新任务
          uploadOne(item, retryCount + 1, onDone);
        }, delay);
        return;
      }
      toast(msg + '：' + rel, 'err');
      finish(false, msg);
    };
    xhr.onerror = function () {
      if (retryCount < MAX_RETRY) {
        statusEl.textContent = '网络错误，重试中…';
        barEl.className = 'h-full bg-amber-500';
        setTimeout(function () {
          row.remove();
          uploadOne(item, retryCount + 1, onDone);
        }, 800 * Math.pow(2, retryCount));
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

  // 原生下载：由浏览器直接下载 URL，不经过 XHR，内存占用恒定
  function nativeDownload(name) {
    var a = document.createElement('a');
    a.href = withKey(API + '/download/' + encodeURIComponent(name));
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 0);
  }

  // 小文件下载：XHR + blob，可显示进度
  function xhrDownload(name, onDone) {
    var url = withKey(API + '/download/' + encodeURIComponent(name));
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
      if (xhr.status !== 200) { toast('下载失败：' + name, 'err'); if (onDone) onDone(false); return; }
      var blob = xhr.response;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      toast('下载完成：' + name, 'ok');
      if (onDone) onDone(true);
    };
    xhr.onerror = function () { toast('下载失败：' + name, 'err'); if (onDone) onDone(false); };
    xhr.send();
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
    var url = withKey(API + '/download/' + encodeURIComponent(name));
    var progress = null;
    try {
      progress = showProgress('正在下载 ' + name);
    } catch (e) {
      progress = null;
    }
    var controller = new AbortController();
    if (progress) progress.cancel = function () { controller.abort(); };

    // 先让用户选择保存位置
    var picker = window.showSaveFilePicker({
      suggestedName: name,
      // 允许用户选择任意目录，避免默认下载目录被清理
      id: 'localsend-download',
    });
    Promise.resolve(picker)
      .then(function (handle) {
        return handle.createWritable().then(function (writer) {
          return fetch(url, { signal: controller.signal })
            .then(function (res) {
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
    var url = withKey(API + '/zip?names=' + encodeURIComponent(names.join(',')));
    var stamp = new Date();
    var p = function (x) { return String(x).padStart(2, '0'); };
    var fname = 'localsend-' + stamp.getFullYear() + p(stamp.getMonth() + 1) + p(stamp.getDate()) + '-' + p(stamp.getHours()) + p(stamp.getMinutes()) + '.zip';
    var a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 0);
    toast('正在打包下载 ' + names.length + ' 个文件…', 'ok');
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
    var url = withKey(API + '/preview/' + encodeURIComponent(name));
    var size = fileSizeOf(name);

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
          pre.textContent = t.length > TEXT_PREVIEW_LIMIT ? t.slice(0, TEXT_PREVIEW_LIMIT) + '\n\n... (内容过长已截断，共 ' + t.length + ' 字符)' : t;
        })
        .catch(function () { toast('预览失败', 'err'); });
      return;
    }
    // 其它类型：尝试在弹窗内联，不行就新窗口打开
    window.open(url, '_blank');
  }

  /** 以媒体方式展示预览内容 */
  function showMediaPreview(name, url, html) {
    $('previewModal').classList.remove('hidden');
    $('previewTitle').textContent = name;
    $('previewOpen').href = url;
    $('previewContent').classList.add('hidden');
    $('previewContent').textContent = '';
    var body = $('previewBody');
    body.classList.remove('hidden');
    body.innerHTML = html;
  }

  function copyLink(name) {
    copyText(withKey(location.origin + API + '/download/' + encodeURIComponent(name)));
  }
  // 生成分享链接（带时效，无需访问令牌即可下载）
  function shareFiles(names, label) {
    if (!names || !names.length) return;
    fetch(withKey(API + '/share'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: names })
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.code !== 0) { toast(json.msg || '分享失败', 'err'); return; }
        var url = location.origin + json.data.url;
        copyText(url);
        var tip = label || (json.data.names.length > 1 ? json.data.names.length + ' 个文件' : json.data.names[0]);
        toast('分享链接已复制（' + tip + '，24 小时内有效）', 'ok');
        refreshShareCount();
      })
      .catch(function () { toast('分享失败', 'err'); });
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
    fetch(withKey(API + '/paste'), {
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
    fetch(withKey(API + '/share'))
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
    fetch(withKey(API + '/share'))
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
              '<button data-act="revoke" class="px-2 py-1 rounded text-[11px] text-red-400 hover:bg-red-500/10 border border-red-500/30 transition">撤销</button>' +
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
    fetch(withKey(API + '/share/' + encodeURIComponent(token)), { method: 'DELETE' })
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
   * 比复制链接更顺手。浏览器不支持时回退为复制下载链接。
   */
  function systemShare(name) {
    if (typeof navigator.share !== 'function') {
      copyLink(name);
      toast('当前浏览器不支持系统分享，已复制下载链接', 'ok');
      return;
    }
    var url = withKey(location.origin + API + '/download/' + encodeURIComponent(name));
    // 能拿到文件本体时一并分享文件本身（移动端体验最好）
    fetch(url)
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
        if (err && err.name === 'AbortError') return;
        navigator.share({ title: name, text: name + '\n' + url }).catch(function () {});
      });
  }

  function deleteFile(name) {
    if (!window.confirm('确定删除文件：' + name + ' ？（删除后可在回收站还原）')) return;
    fetch(withKey(API + '/delete/' + encodeURIComponent(name)), { method: 'DELETE' })
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
    fetch(withKey(API + '/trash/' + encodeURIComponent(id) + '/restore'), { method: 'POST' })
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
    fetch(withKey(API + '/trash'))
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
    fetch(withKey(API + '/trash'))
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
            '<button data-act="restore" class="px-2 py-1 rounded text-xs text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/30 transition shrink-0">还原</button>' +
            '<button data-act="purge" class="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-500/10 border border-red-500/30 transition shrink-0">彻底删除</button>';
          var restoreBtn = div.querySelector('[data-act="restore"]');
          var purgeBtn = div.querySelector('[data-act="purge"]');
          restoreBtn.addEventListener('click', function () {
            restoreTrashEntry(item.id, function (ok, msg) {
              if (ok) { toast('已还原：' + msg, 'ok'); loadTrashList(); }
              else toast(msg || '还原失败', 'err');
            });
          });
          purgeBtn.addEventListener('click', function () {
            fetch(withKey(API + '/trash/' + encodeURIComponent(item.id)), { method: 'DELETE' })
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
  // 按目录筛选
  $('dirSelect').addEventListener('change', function (e) {
    dirFilter = e.target.value;
    currentPage = 1;
    loadFiles();
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

  // 页面任意处直接粘贴（Ctrl+V）即可分享文本或截图
  document.addEventListener('paste', function (e) {
    var target = e.target;
    // 在输入框 / 文本域里粘贴时保持默认行为
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    var dt = e.clipboardData || e.dataTransfer;
    if (!dt) return;
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
  }
  $('closePreview').addEventListener('click', closePreviewModal);
  $('previewModal').addEventListener('click', function (e) { if (e.target === $('previewModal')) closePreviewModal(); });
  // 回收站
  $('trashBtn').addEventListener('click', openTrash);
  $('closeTrash').addEventListener('click', function () { $('trashModal').classList.add('hidden'); });
  $('trashModal').addEventListener('click', function (e) { if (e.target === $('trashModal')) $('trashModal').classList.add('hidden'); });
  $('trashEmpty').addEventListener('click', function () {
    if (!window.confirm('确定清空回收站？其中的文件将无法还原。')) return;
    fetch(withKey(API + '/trash'), { method: 'DELETE' })
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
      dirFilter = dirFilter === dirEl.dataset.dir ? '' : dirEl.dataset.dir;
      currentPage = 1;
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
    else if (act === 'copy') copyLink(name);
    else if (act === 'qr') showQr(withKey(location.origin + API + '/download/' + encodeURIComponent(name)), '扫码直连下载：' + name);
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
      fetch(withKey(API + '/delete/' + encodeURIComponent(names[done])), { method: 'DELETE' })
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

  loadFiles();
  loadFacets();
  refreshTrashCount();
  refreshShareCount();
  updateInboxBadge();
  connectEvents();

  // 注册 Service Worker，提供离线可用的页面外壳
  // 仅在安全上下文可用（https 或 localhost）；局域网 http 下浏览器会拒绝注册
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () {
      var swUrl = '/localsend/sw.js' + (KEY ? '?key=' + encodeURIComponent(KEY) : '');
      navigator.serviceWorker.register(swUrl).catch(function () {
        // 注册失败不影响正常使用，静默忽略
      });
    });
  }
})();

/*
 * LocalSend 离线壳 Service Worker
 *
 * 目标：断网或服务端临时不可用时，页面外壳（HTML / 样式 / 脚本 / 图标）
 * 仍然可以从缓存加载，保证用户能看到界面并得到明确提示。
 *
 * 策略：
 *  - 页面导航：优先走网络，失败时回退到缓存的外壳
 *  - 静态资源：缓存优先，命中即返回，同时后台更新
 *  - 接口请求（/localsend/api/）：一律走网络，绝不缓存，避免出现过期文件列表
 *
 * 注意：Service Worker 只在安全上下文可用（https 或 localhost），
 * 通过局域网 IP 的 http 访问时不会注册，这是浏览器的安全限制。
 */

const CACHE_NAME = 'localsend-shell-v1';

/** 需要预缓存的外壳文件（相对 Service Worker 所在目录） */
const SHELL_FILES = [
  './',
  './app.js',
  './style.css',
  './vendor/qr-code-styling.js',
  './manifest.webmanifest',
  './favicon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/** 注册时可能带了访问令牌，安装后启动地址会丢失，这里记住以便补回 */
const KEY = new URL(self.location.href).searchParams.get('key') || '';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 只处理同源请求
  if (url.origin !== self.location.origin) return;
  // 接口永远走网络
  if (url.pathname.indexOf('/localsend/api/') >= 0) return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

/** 页面导航：网络优先，失败回退缓存 */
async function handleNavigate(req) {
  const url = new URL(req.url);
  // 以应用方式启动时地址栏没有令牌，补回后再加载
  if (KEY && !url.searchParams.get('key')) {
    url.searchParams.set('key', KEY);
    return Response.redirect(url.toString(), 302);
  }
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put('./', fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await caches.match('./');
    if (cached) return cached;
    return new Response(
      '<meta charset="utf-8"><div style="font-family:system-ui;padding:40px;text-align:center">' +
        '<h2>当前离线</h2><p>尚未缓存页面内容，请先联网打开一次。</p></div>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

/** 静态资源：缓存优先并在后台更新 */
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    fetch(req)
      .then((fresh) => {
        if (fresh && fresh.ok) return caches.open(CACHE_NAME).then((c) => c.put(req, fresh.clone()));
        return undefined;
      })
      .catch(() => undefined);
    return cached;
  }
  const fresh = await fetch(req);
  if (fresh && fresh.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, fresh.clone());
  }
  return fresh;
}

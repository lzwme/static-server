/*
 * LocalSend 离线壳 Service Worker
 *
 * 目标：断网或服务端临时不可用时，页面外壳（HTML / 样式 / 脚本 / 图标）
 * 仍然可以从缓存加载，保证用户能看到界面并得到明确提示。
 *
 * 策略：
 *  - 页面导航：优先走网络，失败时回退到缓存的外壳
 *  - 脚本与样式：网络优先（局域网内几乎瞬时可达），保证服务端升级后立即生效
 *  - 其它静态资源：缓存优先并后台更新
 *  - 接口请求（/localsend/api/）：一律走网络，绝不缓存，避免出现过期文件列表
 *
 * 注意：Service Worker 只在安全上下文可用（https 或 localhost），
 * 通过局域网 IP 的 http 访问时不会注册，这是浏览器的安全限制。
 */

const CACHE_NAME = 'localsend-shell-v2';

/** 需要预缓存的外壳文件（相对 Service Worker 所在目录） */
const SHELL_FILES = [
  './',
  './app.js',
  './crypto.js',
  './style.css',
  './vendor/qr-code-styling.js',
  './manifest.webmanifest',
  './favicon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

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
  // 页面脚本与样式在局域网内几乎瞬时可达，改为网络优先，
  // 避免服务端升级后仍使用旧版本；离线时再回退到缓存
  if (/\.(js|css)$/.test(url.pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

/** 网络优先：拿到新内容就更新缓存，失败时回退缓存 */
async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw new Error('离线且没有缓存');
  }
}

/** 页面导航：网络优先，失败回退缓存 */
async function handleNavigate(req) {
  const url = new URL(req.url);
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

// 查班小助手 · Service Worker
// 策略：HTML/导航 走网络优先（保证每次打开都是最新的），静态资源走缓存优先（离线可看）。
// 缓存版本必须随发布递增，否则用户会一直吃旧缓存。
const VERSION = 'sw-2026-10-23T12:56:47';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './app.js?v=2026-10-23T12%3A56%3A47',
  './weather.js?v=2026-10-23T12%3A56%3A47',
  './xlsx.js?v=2026-10-23T12%3A56%3A47',
  './xls.js?v=2026-10-23T12%3A56%3A47',
  './parser.js?v=2026-10-23T12%3A56%3A47',
  './rooms.js?v=2026-10-23T12%3A56%3A47',
  './tips.js?v=2026-10-23T12%3A56%3A47',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        // 新版本接管后把还开着的旧页面刷一次，避免停在旧缓存
        clients.forEach((client) => {
          if ('navigate' in client) {
            client.navigate(client.url).catch(() => {});
          }
        });
      })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 天气接口等跨域请求不接管

  const isNavigation = req.mode === 'navigate';
  const isHtml = isNavigation || url.pathname.endsWith('/')
    || url.pathname.endsWith('.html') || url.pathname.endsWith('/index.html');

  if (isHtml) {
    // 网络优先：拿到就用新的，顺手更新缓存；断网才回退缓存
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  const isCode = url.pathname.endsWith('.js') || url.pathname.endsWith('.css')
    || url.pathname.endsWith('.webmanifest');

  if (isCode) {
    // 代码走网络优先：只要在线就一定用最新的，断网才回退缓存
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 图片等静态资源：缓存优先 + 后台更新（stale-while-revalidate）
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});

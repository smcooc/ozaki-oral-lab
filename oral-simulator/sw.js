// 配信物だけを保存する。写真・症例・任意URLはキャッシュへ入れない。
const VERSION = '8fc0dd97b9979103'; // 配信パッケージでは全静的ファイルのハッシュへ置換
const PREFIX = `ozaki-oral:${new URL(self.registration.scope).pathname}:`;
const CACHE = PREFIX + VERSION;
const FILES = [
  './index.html', './manifest.webmanifest', './css/style.css', './data/tooth-norms.csv',
  './icons/icon.svg', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png',
  './js/app.js', './js/install.js', './js/arch.js', './js/arrange.js', './js/corrections.js',
  './js/editor2d.js', './js/fitting.js', './js/reconstruct3d.js', './js/report.js',
  './js/segmentation.js', './js/setup.js', './js/stl.js', './js/tooth-adjust.js',
  './js/tooth-library.js', './js/viewer3d.js',
  '../shared/css/base.css', '../shared/js/camera.js', '../shared/js/case-store.js',
  '../shared/js/imaging.js', '../shared/js/sync.js', '../shared/js/ui.js', '../vendor/three.module.min.js',
].map(p => new URL(p, self.registration.scope).href);
const ALLOWED = new Set(FILES);
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('message', e => { if (e.data?.type === 'APPLY_UPDATE') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  let key = url.href;
  if (e.request.mode === 'navigate' && [self.registration.scope, new URL('index.html', self.registration.scope).href].includes(url.origin + url.pathname))
    key = new URL('index.html', self.registration.scope).href;
  if (!ALLOWED.has(key)) return;
  e.respondWith(caches.open(CACHE).then(async c => await c.match(key) || fetch(e.request)));
});

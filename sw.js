// 梨的工作台 Service Worker
// 策略：网络优先，缓存兜底（保证每次打开优先拿最新版，离线时可用缓存）

var CACHE_NAME = 'li-workbench-v1';
var CORE_ASSETS = [
  'personal-workbench.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'cloud-sync.js',
  'status-tag.js',
  'status-badge.css'
];

// 安装：预缓存核心资源
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(CORE_ASSETS).catch(function () {});
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// fetch：网络优先，失败回退缓存
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then(function (netResp) {
      // 网络成功：返回并后台缓存
      if (netResp && netResp.status === 200) {
        var respClone = netResp.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, respClone);
        });
      }
      return netResp;
    }).catch(function () {
      // 网络失败：用缓存兜底（离线可用）
      return caches.match(event.request).then(function (cached) {
        return cached || caches.match('personal-workbench.html');
      });
    })
  );
});

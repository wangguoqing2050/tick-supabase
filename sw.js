// Service Worker - Tick 打卡记录器 v2.0
// 策略：HTML 入口用 Network-First + 缓存穿透，其他资源用 Stale-While-Revalidate
// 核心修复：install 阶段不再预缓存 HTML（避免 CDN 旧版本被锁入 SW 缓存）
var CACHE_NAME = 'punch-clock-v32';
var APP_VERSION = 'v32-20260522';

// 只预缓存非 HTML 的静态资源（HTML 由 fetch 处理器动态缓存）
var staticAssets = [
  'manifest-v3.json'
];

// === 安装：只预缓存非 HTML 资源 ===
self.addEventListener('install', function(event) {
  console.log('[Tick SW] install v27');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(staticAssets).catch(function(err) {
        console.log('[Tick SW] 预缓存失败（可忽略）:', err);
      });
    })
  );
  self.skipWaiting();
});

// === 激活：删除所有旧版本缓存 ===
self.addEventListener('activate', function(event) {
  console.log('[Tick SW] activate v27');
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(name) { return name !== CACHE_NAME; })
             .map(function(name) {
               console.log('[Tick SW] 删除旧缓存:', name);
               return caches.delete(name);
             })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// === 消息：允许页面手动触发 skipWaiting ===
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'skipWaiting') {
    console.log('[Tick SW] skipWaiting');
    self.skipWaiting();
  }
});

// === 请求拦截 ===
self.addEventListener('fetch', function(event) {
  var url = event.request.url;

  // 跳过云开发 SDK 和第三方 CDN
  if (url.indexOf('static.cloudbase.net') > -1) return;
  if (url.indexOf('tcb-') > -1 && url.indexOf('service.tcloudbase.com') > -1) return;
  if (url.indexOf('chrome-extension') > -1 || url.indexOf('extension://') > -1) return;

  if (event.request.method !== 'GET') return;

  // 判断是否 HTML 入口请求
  var isNavigation = event.request.mode === 'navigate';
  var isRoot = url === self.location.origin + '/' ||
               url === self.location.origin + '/index.html' ||
               url.indexOf('/index.html') > -1;
  var isHtmlEntry = isNavigation || isRoot;

  if (isHtmlEntry) {
    // ====== HTML 入口：Network-First + CDN 穿透 ======
    event.respondWith(
      // 构造带缓存穿透参数的请求 URL（绕过 CDN 缓存）
      fetchHtmlFresh().then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          // 用原始 URL 作为缓存键
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        // 网络失败时回退到缓存
        return caches.match(event.request).then(function(cached) {
          return cached || caches.match('/') || new Response('离线 — 请连接网络后重试', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
      })
    );
  } else if (url.indexOf(self.location.origin) === 0) {
    // ====== 同源静态资源：Stale-While-Revalidate ======
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        var networkFetch = fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        }).catch(function() {});

        return cached || networkFetch;
      })
    );
  }
  // 跨域资源不处理
});

// 发起绕过 CDN 缓存的 HTML 请求
function fetchHtmlFresh() {
  // 1. 尝试不带参数的直接请求（浏览器可能绕过 CDN）
  return fetch(new Request(self.location.origin + '/', {
    cache: 'no-store'
  })).then(function(resp) {
    if (resp && resp.status === 200) return resp;
    throw new Error('direct fetch failed');
  }).catch(function() {
    // 2. 回退：带缓存穿透参数
    return fetch(new Request(self.location.origin + '/?_sw=' + Date.now(), {
      cache: 'no-store'
    }));
  });
}

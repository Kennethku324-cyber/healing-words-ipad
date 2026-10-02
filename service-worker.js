// 療心之言離線快取：第一次喺 HTTPS 網址開過之後，快取晒成個 build，
// 之後 iPad 唔連 Mac 都玩到（語音施法 STT 例外：要上網用 Apple 服務）。
// cache 版本跟 build 戳記（BuildScript 出 build 時填入 261002111055）：
// 新 build → 新 cache 名 → 自動棄舊快取、下次開機拉新版。
const CACHE = 'hw-261002111055';

self.addEventListener('install', (e) => { self.skipWaiting(); });

// 版本查詢：頁面（記錄視圖）問而家行緊邊個 build
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'hw-get-version' && e.source) {
    e.source.postMessage({ type: 'hw-sw-version', v: CACHE });
  }
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // 廣播版本：俾頁面（記錄視圖）知道而家行緊邊個 build
    const all = await self.clients.matchAll();
    all.forEach((c) => c.postMessage({ type: 'hw-sw-version', v: CACHE }));


    // precache：讀 build 時生成嘅清單，照單全收（離線套裝）
    try {
      const res = await fetch('precache-manifest.json', { cache: 'no-cache' });
      if (res && res.ok) {
        const list = await res.json();
        if (Array.isArray(list.urls)) {
          const cache = await caches.open(CACHE);
          await Promise.allSettled(list.urls.map(async (u) => {
            try {
              const r = await fetch(u, { cache: 'no-cache' });
              if (r && r.ok) await cache.put(u, r);
            } catch (err) {
              console.warn('[HW-SW] precache 失敗：' + u);
            }
          }));
          console.log('[HW-SW] 離線快取完成（' + list.urls.length + ' 個檔案）');
        }
      }
    } catch (err) {
      console.warn('[HW-SW] 讀唔到 precache 清單：' + err);
    }
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 導航（index.html）：network-first — 有網即刻用伺服器最新版，離線先退快取
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-cache' });
        if (fresh && fresh.status === 200) {
          const cache = await caches.open(CACHE);
          await cache.put('index.html', fresh.clone());
          return fresh;
        }
      } catch (err) { /* 離線 */ }
      const hit = (await caches.open(CACHE)).match('index.html');
      if (hit) return hit;
      throw err;
    })());
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit; // cache-first：離線照行
    try {
      // miss 一律 no-cache：唔准 Safari HTTP 快取（max-age 600）派舊版，
      // 否則新舊檔案溝埋 → wasm/framework 版本唔配 → LinkError
      const fresh = await fetch(req, { cache: 'no-cache' });
      if (fresh && fresh.status === 200) await cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      throw err;
    }
  })());
});

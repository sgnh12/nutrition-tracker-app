// ホーム画面へのインストール条件を満たすための最小のService Worker(オフライン対応はしない)
// 画面本体(index.html)とスクリプトは、端末のキャッシュ(GitHub Pagesは10分)に頼らず、開くたびに最新かを確かめる。
// 変わっていなければ304で済むので通信は軽い。つながらないときは普通の取得に任せる
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' || /\.(html|js)$/.test(url.pathname)) {
    event.respondWith(fetch(req, { cache: 'no-cache' }).catch(function () { return fetch(req); }));
  }
});

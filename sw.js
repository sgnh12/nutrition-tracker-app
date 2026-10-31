// ホーム画面へのインストール条件を満たすための最小のService Worker。通信はそのまま通す(オフライン対応はしない)
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () {});

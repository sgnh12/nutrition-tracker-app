// pwa/gas-shim.js
// GitHub Pages上で動く画面から、GASを呼ぶための部品。
// 画面のコードは google.script.run のまま変えずに、裏で fetch(通信)に置き換える。
// 接続先のURLと合言葉は、このスマホの中(localStorage と IndexedDB の2か所)に保存する。
(function (root) {
  'use strict';

  // 本番のGASのURL。合言葉が無いと使えないため、コードに含めてよい。
  // 保存済みのURLがあればそちらを優先する(= 入力したURLが消えても、ここから復元できる)
  var DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbxMMQTRW8U_Vd5_gLs6oBp86hwoSA6W8EpG_iwgEk4P5ChBUwhGlXrlE6nDcEa4rHeh/exec';
  var STORAGE_KEY = 'nutritionTracker.connection.v1';
  var IDB_NAME = 'nutritionTracker';
  var IDB_STORE = 'kv';
  var REQUEST_TIMEOUT_MS = 45000;

  // ---------- 設定の整形(ブラウザに依存しない部分) ----------

  function normalizeConfig(value) {
    if (!value || typeof value !== 'object') return null;
    var url = typeof value.url === 'string' ? value.url.trim() : '';
    var token = typeof value.token === 'string' ? value.token.trim() : '';
    if (!url && !token) return null;
    return { url: url, token: token };
  }

  // #k=合言葉&u=URL の形で渡された設定を取り出す(合言葉を失ったときの復元用リンク)
  function parseSetupHash(hash) {
    if (typeof hash !== 'string' || hash.charAt(0) !== '#') return null;
    var params = {};
    hash.slice(1).split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i > 0) params[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    });
    return normalizeConfig({ url: params.u, token: params.k });
  }

  // 保存先が複数あるとき、合言葉が入っているものを優先し、足りない項目は他から補う
  function pickConfig(candidates) {
    var list = candidates.map(normalizeConfig).filter(Boolean);
    if (list.length === 0) return null;
    var withToken = list.filter(function (c) { return c.token; })[0] || list[0];
    var url = withToken.url || (list.filter(function (c) { return c.url; })[0] || {}).url || '';
    return { url: url, token: withToken.token };
  }

  function sameConfig(a, b) {
    return !!a && !!b && a.url === b.url && a.token === b.token;
  }

  // stores: [{ read: () => Promise<cfg|null>, write: (cfg) => Promise }]
  function loadFromStores(stores) {
    return Promise.all(stores.map(function (s) {
      return s.read().then(function (v) { return normalizeConfig(v); }, function () { return null; });
    })).then(function (values) {
      var chosen = pickConfig(values);
      if (!chosen) return null;
      // どこかの保存先で欠けていたら、残っている方から書き戻す
      return Promise.all(stores.map(function (s, i) {
        if (sameConfig(values[i], chosen)) return null;
        return s.write(chosen).catch(function () {});
      })).then(function () { return chosen; });
    });
  }

  // 1か所でも保存できれば成功。どこにも保存できなかったときだけ失敗にする
  function saveToStores(stores, cfg) {
    return Promise.all(stores.map(function (s) {
      return s.write(cfg).then(function () { return true; }, function () { return false; });
    })).then(function (results) {
      var saved = results.filter(Boolean).length;
      if (saved === 0) throw new Error('このスマホに保存できませんでした');
      return saved;
    });
  }

  // ---------- google.script.run の代わり(ブラウザに依存しない部分) ----------

  function createRunner(callServer) {
    function make(success, failure) {
      return new Proxy({}, {
        get: function (target, name) {
          if (typeof name !== 'string' || name === 'then') return undefined;
          if (name === 'withSuccessHandler') return function (fn) { return make(fn, failure); };
          if (name === 'withFailureHandler') return function (fn) { return make(success, fn); };
          if (name === 'withUserObject') return function () { return make(success, failure); };
          return function () {
            var args = Array.prototype.slice.call(arguments);
            callServer(name, args).then(function (result) {
              if (success) success(result);
            }, function (err) {
              if (failure) failure(err);
              else if (typeof console !== 'undefined') console.error(err);
            });
          };
        }
      });
    }
    return make(null, null);
  }

  var api = {
    DEFAULT_GAS_URL: DEFAULT_GAS_URL,
    normalizeConfig: normalizeConfig,
    parseSetupHash: parseSetupHash,
    pickConfig: pickConfig,
    loadFromStores: loadFromStores,
    saveToStores: saveToStores,
    createRunner: createRunner
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ---------- ここから先はブラウザ専用 ----------

  var localStore = {
    read: function () {
      return new Promise(function (resolve) {
        try { resolve(JSON.parse(localStorage.getItem(STORAGE_KEY))); } catch (e) { resolve(null); }
      });
    },
    write: function (cfg) {
      return new Promise(function (resolve, reject) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); resolve(); } catch (e) { reject(e); }
      });
    }
  };

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('indexedDB unavailable')); return; }
      var req = root.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var idbStore = {
    read: function () {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(STORAGE_KEY);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { reject(req.error); };
        });
      });
    },
    write: function (cfg) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(cfg, STORAGE_KEY);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    }
  };

  var stores = [localStore, idbStore];
  var state = { cfg: null };
  var readyPromise = null;
  var resolveReady = null;

  // ブラウザに、この保存内容を勝手に消さないよう頼む(ホーム画面に追加したアプリでは通常、自動で認められる)
  function requestPersistence() {
    try {
      if (root.navigator.storage && root.navigator.storage.persist) return root.navigator.storage.persist();
    } catch (e) { /* 未対応のブラウザ */ }
    return Promise.resolve(false);
  }

  function describePersistence() {
    try {
      if (root.navigator.storage && root.navigator.storage.persisted) return root.navigator.storage.persisted();
    } catch (e) { /* 未対応のブラウザ */ }
    return Promise.resolve(null);
  }

  // ---------- 通信 ----------

  function makeError(message, code) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  // silent: 接続設定の画面から確認するときは、合言葉エラーで設定画面を開き直さない
  function request(cfg, name, args, silent) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(cfg.url, {
      method: 'POST',
      body: JSON.stringify({ token: cfg.token, fn: name, args: args }),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      return res.text();
    }, function (err) {
      throw makeError(err && err.name === 'AbortError'
        ? '通信がタイムアウトしました。もう一度お試しください。'
        : '通信に失敗しました。ネットワークを確認してください。', 'network');
    }).then(function (text) {
      var body;
      try { body = JSON.parse(text); } catch (e) {
        throw makeError('サーバーの応答を読み取れませんでした。GASの公開設定を確認してください。', 'bad_response');
      }
      if (!body.ok) {
        if (body.code === 'unauthorized' && !silent) openSetup(body.error);
        throw makeError(body.error || 'サーバーでエラーが発生しました', body.code || 'server_error');
      }
      return body.result;
    }).then(function (result) {
      if (timer) clearTimeout(timer);
      return result;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function callServer(name, args) {
    return ready().then(function () { return request(state.cfg, name, args); });
  }

  // ---------- 設定の読み込み ----------

  function ready() {
    if (!readyPromise) {
      readyPromise = new Promise(function (resolve) { resolveReady = resolve; });
      initConfig();
    }
    return readyPromise;
  }

  function finishSetup(cfg) {
    state.cfg = cfg;
    if (resolveReady) { resolveReady(); resolveReady = null; }
  }

  function initConfig() {
    var fromHash = parseSetupHash(root.location.hash);
    var hashSaved = Promise.resolve();
    if (fromHash && fromHash.token) {
      var hashCfg = { url: fromHash.url || DEFAULT_GAS_URL, token: fromHash.token };
      hashSaved = saveToStores(stores, hashCfg).catch(function () {});
      try { root.history.replaceState(null, '', root.location.pathname + root.location.search); } catch (e) { /* そのまま */ }
    }
    hashSaved.then(function () {
      return loadFromStores(stores);
    }).then(function (cfg) {
      if (cfg && cfg.token) {
        finishSetup({ url: cfg.url || DEFAULT_GAS_URL, token: cfg.token });
        requestPersistence();
      } else {
        openSetup('');
      }
    });
  }

  // ---------- 接続設定の画面 ----------

  var overlay = null;

  function el(id) { return document.getElementById(id); }

  function ensureOverlay() {
    if (overlay) return overlay;
    var style = document.createElement('style');
    style.textContent =
      '#conn-overlay{display:none;position:fixed;inset:0;z-index:50;background:var(--ground,#edf1f4);overflow-y:auto;padding:24px 16px}' +
      '#conn-overlay.open{display:block}' +
      '#conn-overlay .conn-panel{max-width:480px;margin:0 auto}' +
      '#conn-overlay h1{font-size:1.2rem;margin:8px 0 12px}' +
      '#conn-overlay p{margin:0 0 16px;font-size:.9rem;color:var(--muted,#5e6e7a)}' +
      '#conn-overlay label{display:block;margin-bottom:14px;font-size:.78rem;font-weight:700;color:var(--muted,#5e6e7a)}' +
      '#conn-overlay input{margin-top:6px}' +
      '#conn-overlay .conn-actions{display:flex;gap:8px;margin-top:8px}' +
      '#conn-overlay .conn-actions .btn{flex:1}';
    document.head.appendChild(style);
    overlay = document.createElement('div');
    overlay.id = 'conn-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<div class="conn-panel">' +
      '<h1>接続設定</h1>' +
      '<p>データを保存しているGoogleスプレッドシートに接続するための設定です。一度保存すると、このスマホに記憶されます。</p>' +
      '<label>GASのURL<input type="url" id="conn-url" autocomplete="off" autocapitalize="off" spellcheck="false"></label>' +
      '<label>合言葉<input type="password" id="conn-token" autocomplete="off" autocapitalize="off" spellcheck="false"></label>' +
      '<div id="conn-status" class="status" role="status"></div>' +
      '<div class="conn-actions">' +
      '<button type="button" class="btn" id="conn-close">閉じる</button>' +
      '<button type="button" class="btn btn-primary" id="conn-save">保存して接続</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    el('conn-close').addEventListener('click', function () { overlay.classList.remove('open'); });
    el('conn-save').addEventListener('click', onSaveClick);
    return overlay;
  }

  function openSetup(message) {
    var show = function () {
      ensureOverlay();
      var cfg = state.cfg;
      // すでに開いている間は、入力中の内容を上書きしない
      if (!overlay.classList.contains('open')) {
        el('conn-url').value = (cfg && cfg.url) || DEFAULT_GAS_URL;
        el('conn-token').value = (cfg && cfg.token) || '';
      }
      el('conn-status').textContent = message || '';
      // 合言葉がまだ無いときは、閉じて先に進めないようにする
      el('conn-close').style.display = state.cfg ? '' : 'none';
      overlay.classList.add('open');
    };
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show);
  }

  function onSaveClick() {
    var url = el('conn-url').value.trim();
    var token = el('conn-token').value.trim();
    var status = el('conn-status');
    if (!url || !token) {
      status.textContent = 'GASのURLと合言葉の両方を入力してください。';
      return;
    }
    var cfg = { url: url, token: token };
    var btn = el('conn-save');
    btn.disabled = true;
    status.textContent = '保存しています…';
    // 入力した内容は、接続できるか確かめる前に必ず保存する(失敗しても入力し直さずに済むように)
    saveToStores(stores, cfg).then(function () {
      requestPersistence();
      status.textContent = '接続を確認しています…';
      return request(cfg, 'ping', [], true);
    }).then(function () {
      finishSetup(cfg);
      status.textContent = '';
      overlay.classList.remove('open');
      renderSummary();
    }, function (err) {
      var saved = err && err.code ? ' 入力した内容はこのスマホに保存されています。' : '';
      status.textContent = (err && err.message ? err.message : '接続できませんでした。') + saved;
    }).then(function () { btn.disabled = false; });
  }

  // 設定画面の末尾に「接続」欄を足す
  function renderSummary() {
    var box = el('conn-summary');
    if (!box) return;
    var cfg = state.cfg;
    describePersistence().then(function (persisted) {
      var lines = [];
      lines.push('合言葉: ' + (cfg && cfg.token ? '保存済み' : '未設定'));
      lines.push('接続先: ' + (cfg && cfg.url ? '…' + cfg.url.slice(-12) : '未設定'));
      if (persisted === true) lines.push('保存の保護: 有効(ブラウザに消されにくい設定)');
      else if (persisted === false) lines.push('保存の保護: 未確認(ホーム画面に追加すると有効になりやすい)');
      box.textContent = lines.join(' / ');
    });
  }

  function addSettingsSection() {
    var tab = el('tab-settings');
    if (!tab || el('conn-summary')) return;
    var title = document.createElement('h2');
    title.className = 'section-title';
    title.textContent = '接続';
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div id="conn-summary" class="status" role="status"></div>' +
      '<button type="button" class="btn btn-block" id="conn-open">接続設定を開く</button>';
    tab.appendChild(title);
    tab.appendChild(card);
    el('conn-open').addEventListener('click', function () { openSetup(''); });
    ready().then(renderSummary);
  }

  // ---------- 起動 ----------

  root.google = root.google || {};
  root.google.script = { run: createRunner(callServer) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addSettingsSection);
  else addSettingsSection();
})(typeof window !== 'undefined' ? window : globalThis);

/* ============================================================
   云同步模块 cloud-sync.js v1
   ------------------------------------------------------------
   给「梨的工作台」提供跨设备数据同步能力（网吧 / 手机 / 多台电脑）。

   后端：Supabase（免费额度足够、国内可直接访问、无需备案域名）
   表结构（见配置教程中的 SQL）：
     workbench_data (code, key, value, t)  主键 (code, key)

   同步策略：
     - 每个数据 key（任务 / 随手记 / 番茄钟 / 记账 / 导航顺序）
       各自带修改时间戳 t，与云端按「后写赢」合并；
     - 云端较新 → 写入本地并刷新页面；
     - 本地较新 → 推送到云端（只推送有变化的 key，不覆盖其他 key）。

   本文件自包含：样式、UI、逻辑全部内置，不依赖页面其他代码。
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量与状态 ---------------- */

  var SYNC_KEYS = [
    'li-workbench-tasks',
    'li-workbench-tasks-notes',
    'li-workbench-tasks-mobile',
    'quick-note-v2',
    'pomodoro-data',
    'accounting-v2',
    'li-workbench-nav-order'
  ];

  var CONFIG_KEY = 'cloud-sync-config';
  var META_KEY = 'cloud-sync-meta';
  var CLOUD_CACHE_KEY = 'cloud-sync-cloud-cache';
  var TABLE = 'workbench_data';

  var SQL_TEXT = [
    'create table if not exists workbench_data (',
    '  code text not null,',
    '  key text not null,',
    '  value text,',
    '  t bigint not null default 0,',
    '  primary key (code, key)',
    ');',
    'alter table workbench_data enable row level security;',
    'drop policy if exists "workbench_all" on workbench_data;',
    'create policy "workbench_all" on workbench_data',
    '  for all to anon, authenticated',
    '  using (true) with check (true);'
  ].join('\n');

  var state = {
    syncing: false,        // 是否正在同步
    lastSyncAt: 0,         // 上次同步完成时间
    lastResult: null,      // { ok, time, msg }
    applying: false,       // 正在把云端数据写入本地（不记为本地修改）
    pushTimer: null,       // 防抖推送定时器
    modalOpen: false,      // 设置面板是否打开
    modalMode: 'status',   // 'status' | 'config'
    pendingReload: false,  // 用户正在编辑，暂缓刷新
    firstPullDone: false,  // 本次会话是否完成过一次拉取
    lastCloudMap: readJSON(CLOUD_CACHE_KEY, null) // 最近一次拉到的云端数据快照
  };

  /* ---------------- 基础工具 ---------------- */

  var rawSetItem = localStorage.setItem.bind(localStorage);
  var rawRemoveItem = localStorage.removeItem.bind(localStorage);

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function getConfig() {
    var c = readJSON(CONFIG_KEY, null);
    if (!c) return null;
    if (!c.url || !c.key || !c.code) return null;
    return c;
  }

  function getMeta() { return readJSON(META_KEY, {}) || {}; }
  function setMeta(m) { rawSetItem(META_KEY, JSON.stringify(m)); }

  function normUrl(u) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }

  function apiHeaders(cfg, extra) {
    var h = {
      'apikey': cfg.key,
      'Authorization': 'Bearer ' + cfg.key,
      'Content-Type': 'application/json'
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    }
    return h;
  }

  function httpErr(prefix, status, body) {
    var msg = prefix + '（HTTP ' + status + '）';
    if (status === 401 || status === 403) msg = prefix + '：地址或 anon key 不正确';
    else if (status === 404) msg = prefix + '：未找到 workbench_data 表，请先在 Supabase 运行教程中的 SQL';
    else if (status === 400 && body) {
      try {
        var j = JSON.parse(body);
        if (j && j.message) msg += ' ' + j.message;
      } catch (e) { /* ignore */ }
    }
    var err = new Error(msg);
    err.handled = true;
    return err;
  }

  function fmtTime(ts) {
    if (!ts) return '从未';
    try {
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return new Date(ts).toString();
    }
  }

  function maskCode(code) {
    if (!code) return '';
    if (code.length <= 6) return code.charAt(0) + '***';
    return code.slice(0, 3) + '****' + code.slice(-3);
  }

  /* ---------------- 本地修改时间跟踪 ----------------
     包装 localStorage.setItem / removeItem，
     凡是写入了同步范围内的 key，都记录修改时间戳。 */

  var _setItem = localStorage.setItem;
  localStorage.setItem = function (k, v) {
    _setItem.call(localStorage, k, v);
    if (state.applying || SYNC_KEYS.indexOf(k) === -1) return;
    // 首次拉取完成前，对从未同步过的 key 的写入（如新设备首开时
    // initData 写入的默认任务）不计为用户修改，避免默认数据
    // 带着最新时间戳覆盖云端真实数据。
    if (!state.firstPullDone && !getMeta()[k]) return;
    touchLocal(k);
  };

  var _removeItem = localStorage.removeItem;
  localStorage.removeItem = function (k) {
    _removeItem.call(localStorage, k);
    if (state.applying || SYNC_KEYS.indexOf(k) === -1) return;
    if (!state.firstPullDone && !getMeta()[k]) return;
    touchLocal(k);
  };

  function touchLocal(k) {
    var m = getMeta();
    m[k] = Date.now();
    setMeta(m);
    schedulePush();
  }

  /* ---------------- 同步核心 ---------------- */

  // 本地视图：{ key: { v: 原始字符串|null, t: 修改时间 } }
  function localEntries() {
    var m = getMeta();
    var out = {};
    SYNC_KEYS.forEach(function (k) {
      var v = localStorage.getItem(k);
      var t = m[k] || 0;
      if (v === null && !t) return; // 本机从未有这项数据
      out[k] = { v: v, t: t };
    });
    return out;
  }

  function schedulePush() {
    if (!getConfig()) return;
    if (state.pushTimer) clearTimeout(state.pushTimer);
    state.pushTimer = setTimeout(function () {
      state.pushTimer = null;
      syncNow({ silent: true });
    }, 4000);
  }

  /**
   * 完整同步：拉取云端 → 逐 key 合并 → 推送本地较新的 key。
   * 返回 Promise<string>：给用户看的提示文案。
   */
  function syncNow(opts) {
    opts = opts || {};
    var cfg = getConfig();
    if (!cfg) {
      if (opts.manual) toast('请先完成云同步设置', 'err');
      return Promise.resolve();
    }
    if (state.syncing) return Promise.resolve();
    state.syncing = true;
    setDot('syncing');

    var base = normUrl(cfg.url) + '/rest/v1/' + TABLE;
    var pullUrl = base + '?code=eq.' + encodeURIComponent(cfg.code) + '&select=key,value,t';

    return fetch(pullUrl, { headers: apiHeaders(cfg) })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (body) {
            throw httpErr('读取云端数据失败', res.status, body);
          });
        }
        return res.json();
      })
      .then(function (rows) {
        var cloudMap = {};
        (rows || []).forEach(function (r) {
          cloudMap[r.key] = { v: (r.value === undefined ? null : r.value), t: r.t || 0 };
        });
        return mergeAndPush(cfg, cloudMap);
      })
      .then(function (result) {
        state.lastSyncAt = Date.now();
        state.lastResult = { ok: true, time: Date.now(), msg: '' };
        setDot('ok');
        if (state.modalOpen) renderModalBody();
        if (result.appliedCount > 0) {
          reloadSoon();
          return '已应用云端更新（' + result.appliedCount + ' 项）';
        }
        return result.pushedCount > 0 ? '同步完成' : '已是最新';
      })
      .catch(function (err) {
        state.lastSyncAt = Date.now();
        state.lastResult = { ok: false, time: Date.now(), msg: err && err.message ? err.message : String(err) };
        setDot('err');
        if (state.modalOpen) renderModalBody();
        if (!opts.silent) toast('同步失败：' + state.lastResult.msg, 'err');
        return '同步失败';
      })
      .then(function (msg) {
        state.syncing = false;
        state.firstPullDone = true;
        if (opts.manual) toast(msg, state.lastResult && state.lastResult.ok ? 'ok' : 'err');
      });
  }

  /**
   * 合并云端与本地，返回 { appliedCount, pushedCount }。
   * - 云端较新的 key：写入本地（记为 applied）；
   * - 本地较新的 key：收集起来推送到云端。
   */
  function mergeAndPush(cfg, cloudMap) {
    // 记录云端快照（供 beforeunload 差量推送使用）
    state.lastCloudMap = cloudMap;
    rawSetItem(CLOUD_CACHE_KEY, JSON.stringify(cloudMap));

    var meta = getMeta();
    var local = localEntries();
    var pushRows = [];
    var appliedCount = 0;
    var appliedEntries = {};
    var metaChanged = false;

    SYNC_KEYS.forEach(function (k) {
      var c = cloudMap[k];      // { v, t } 或 undefined（云端没有）
      var l = local[k];         // { v, t } 或 undefined（本机从未有）

      if (c && l) {
        if (l.t > c.t) {
          pushRows.push({ code: cfg.code, key: k, value: l.v, t: l.t });
        } else if (c.t > l.t) {
          appliedEntries[k] = c;
          meta[k] = c.t; metaChanged = true;
          if (c.v !== l.v) appliedCount++;
        } else {
          // 时间相同：极小概率的并发写，以云端为准
          if (c.v !== l.v) {
            appliedEntries[k] = c;
            meta[k] = c.t; metaChanged = true;
            appliedCount++;
          }
        }
      } else if (c && !l) {
        // 云端有、本机从未有 → 应用云端
        appliedEntries[k] = c;
        meta[k] = c.t; metaChanged = true;
        if (c.v !== null) appliedCount++;
      } else if (!c && l) {
        // 本机有、云端没有 → 推送
        pushRows.push({ code: cfg.code, key: k, value: l.v, t: l.t });
      }
    });

    // 把云端数据写入本地（绕过修改跟踪）
    if (Object.keys(appliedEntries).length) {
      state.applying = true;
      Object.keys(appliedEntries).forEach(function (k) {
        var e = appliedEntries[k];
        if (e.v === null || e.v === undefined) {
          rawRemoveItem(k);
        } else {
          rawSetItem(k, e.v);
        }
      });
      state.applying = false;
    }
    if (metaChanged) setMeta(meta);

    // 推送本地较新的 key
    if (!pushRows.length) {
      return Promise.resolve({ appliedCount: appliedCount, pushedCount: 0 });
    }

    var base = normUrl(cfg.url) + '/rest/v1/' + TABLE;
    return fetch(base, {
      method: 'POST',
      headers: apiHeaders(cfg, { 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify(pushRows)
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (body) {
          throw httpErr('上传数据失败', res.status, body);
        });
      }
      // 推送成功后同步更新本地缓存的云端快照
      if (state.lastCloudMap) {
        pushRows.forEach(function (row) {
          state.lastCloudMap[row.key] = { v: row.value, t: row.t };
        });
        rawSetItem(CLOUD_CACHE_KEY, JSON.stringify(state.lastCloudMap));
      }
      return { appliedCount: appliedCount, pushedCount: pushRows.length };
    });
  }

  /* ---------------- 刷新页面 ---------------- */

  function isEditing() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function reloadSoon() {
    if (isEditing()) {
      state.pendingReload = true;
      toast('已拉取云端更新，稍后自动刷新页面');
      return;
    }
    setTimeout(function () { location.reload(); }, 400);
  }

  document.addEventListener('focusout', function () {
    if (state.pendingReload && !isEditing()) {
      state.pendingReload = false;
      setTimeout(function () { location.reload(); }, 400);
    }
  });

  /* ---------------- UI：侧边栏按钮 ---------------- */

  function setDot(st) {
    var dot = document.getElementById('cysDot');
    if (dot) dot.setAttribute('data-state', st);
  }

  function buildSidebarButton() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    var area = document.createElement('div');
    area.className = 'cys-area';
    area.innerHTML =
      '<button class="cys-btn" id="cysBtn" title="云同步设置">' +
      '  <svg class="nav-icon" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '    <path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98 6 6 0 0 0-11.7 1.62A3.5 3.5 0 0 0 6.5 19h11z"></path>' +
      '  </svg>' +
      '  <span>云同步</span>' +
      '  <span class="cys-dot" id="cysDot" data-state="off"></span>' +
      '</button>';
    sidebar.appendChild(area);

    area.querySelector('#cysBtn').addEventListener('click', function () {
      openModal(getConfig() ? 'status' : 'config');
    });
    setDot(getConfig() ? 'ok' : 'off');
  }

  /* ---------------- UI：设置面板 ---------------- */

  function openModal(mode) {
    state.modalMode = mode || (getConfig() ? 'status' : 'config');
    state.modalOpen = true;

    var old = document.getElementById('cysModal');
    if (old) old.remove();

    var modal = document.createElement('div');
    modal.className = 'cys-modal';
    modal.id = 'cysModal';
    modal.innerHTML =
      '<div class="cys-mask"></div>' +
      '<div class="cys-sheet">' +
      '  <div class="cys-sheet-head">' +
      '    <div class="cys-title">云同步</div>' +
      '    <button class="cys-close" title="关闭">&times;</button>' +
      '  </div>' +
      '  <div class="cys-body" id="cysBody"></div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.querySelector('.cys-mask').addEventListener('click', closeModal);
    modal.querySelector('.cys-close').addEventListener('click', closeModal);
    renderModalBody();
  }

  function closeModal() {
    state.modalOpen = false;
    var m = document.getElementById('cysModal');
    if (m) m.remove();
  }

  function renderModalBody() {
    var body = document.getElementById('cysBody');
    if (!body) return;
    if (state.modalMode === 'config') renderConfigForm(body);
    else renderStatusView(body);
  }

  function renderStatusView(body) {
    var cfg = getConfig();
    if (!cfg) { state.modalMode = 'config'; return renderConfigForm(body); }

    var r = state.lastResult;
    var statusHtml;
    if (state.syncing) {
      statusHtml = '<span class="cys-st cys-st-syncing">同步中…</span>';
    } else if (!r) {
      statusHtml = '<span class="cys-st">尚未同步</span>';
    } else if (r.ok) {
      statusHtml = '<span class="cys-st cys-st-ok">已同步</span>';
    } else {
      statusHtml = '<span class="cys-st cys-st-err">上次失败：' + escapeHtml(r.msg) + '</span>';
    }

    var local = localEntries();
    var syncedCount = Object.keys(local).length;

    body.innerHTML =
      '<div class="cys-info">' +
      '  <div class="cys-row"><span>同步码</span><b>' + escapeHtml(maskCode(cfg.code)) + '</b></div>' +
      '  <div class="cys-row"><span>上次同步</span><b>' + fmtTime(r ? r.time : 0) + '</b></div>' +
      '  <div class="cys-row"><span>同步状态</span><b>' + statusHtml + '</b></div>' +
      '  <div class="cys-row"><span>数据项</span><b>' + syncedCount + ' / ' + SYNC_KEYS.length + '</b></div>' +
      '</div>' +
      '<label class="cys-check">' +
      '  <input type="checkbox" id="cysAuto"' + (cfg.autoSync !== false ? ' checked' : '') + '>' +
      '  <span>自动同步（每 30 秒 + 有修改后自动上传）</span>' +
      '</label>' +
      '<div class="cys-actions">' +
      '  <button class="cys-btn-pri" id="cysSyncNow">立即同步</button>' +
      '  <button class="cys-btn-sec" id="cysEditCfg">修改配置</button>' +
      '</div>' +
      '<div class="cys-actions">' +
      '  <button class="cys-btn-sec cys-danger" id="cysClearCfg">清除本机同步配置</button>' +
      '</div>' +
      '<div class="cys-tip">提示：在网吧等公共设备上用完可点「清除本机同步配置」，只清掉钥匙，不动本地数据。</div>';

    body.querySelector('#cysSyncNow').addEventListener('click', function () {
      syncNow({ manual: true });
    });
    body.querySelector('#cysEditCfg').addEventListener('click', function () {
      state.modalMode = 'config';
      renderModalBody();
    });
    body.querySelector('#cysAuto').addEventListener('change', function (e) {
      var c = getConfig();
      c.autoSync = e.target.checked;
      rawSetItem(CONFIG_KEY, JSON.stringify(c));
      resetTimers();
    });
    body.querySelector('#cysClearCfg').addEventListener('click', function () {
      if (!confirm('确定清除本机的云同步配置吗？（本地数据不受影响）')) return;
      rawRemoveItem(CONFIG_KEY);
      rawRemoveItem(META_KEY);
      rawRemoveItem(CLOUD_CACHE_KEY);
      state.lastCloudMap = null;
      setDot('off');
      toast('已清除本机同步配置');
      closeModal();
    });
  }

  function renderConfigForm(body) {
    var cfg = getConfig() || {};
    body.innerHTML =
      '<div class="cys-tip" style="margin:0 0 14px;">手机 / 网吧 / 多台电脑之间同步数据。首次使用请按下面的教程创建免费云端（约 5 分钟），之后每台设备填同样的三样东西即可。</div>' +
      '<div class="cys-field">' +
      '  <label>Supabase 项目地址</label>' +
      '  <input type="text" id="cysUrl" placeholder="https://xxxxx.supabase.co" autocomplete="off" spellcheck="false" value="' + escapeHtml(cfg.url || '') + '">' +
      '</div>' +
      '<div class="cys-field">' +
      '  <label>anon 公钥（anon public key）</label>' +
      '  <input type="text" id="cysKey" placeholder="eyJhbGciOi..." autocomplete="off" spellcheck="false" value="' + escapeHtml(cfg.key || '') + '">' +
      '</div>' +
      '<div class="cys-field">' +
      '  <label>同步码（自己设定，相当于密码）</label>' +
      '  <input type="text" id="cysCode" placeholder="例如：li-2026-x7k9m2q8" autocomplete="off" spellcheck="false" value="' + escapeHtml(cfg.code || '') + '">' +
      '  <div class="cys-hint">所有设备填同一个同步码才能互通；建议 12 位以上随机字符。</div>' +
      '</div>' +
      '<label class="cys-check">' +
      '  <input type="checkbox" id="cysAuto2" checked>' +
      '  <span>自动同步</span>' +
      '</label>' +
      '<div class="cys-actions">' +
      '  <button class="cys-btn-pri" id="cysSave">保存并连接</button>' +
      '  <button class="cys-btn-sec" id="cysCancel">取消</button>' +
      '</div>' +
      '<details class="cys-tutorial">' +
      '  <summary>首次使用教程（点开查看）</summary>' +
      '  <ol>' +
      '    <li>打开 <a href="https://supabase.com" target="_blank" rel="noopener">supabase.com</a>，注册免费账号（可 GitHub 登录）。</li>' +
      '    <li>新建项目（New Project），名字随意，地区选离你近的即可。</li>' +
      '    <li>在左侧 SQL Editor 里粘贴并运行下面的 SQL 建表。</li>' +
      '    <li>在 项目设置 → API 里，复制 <b>Project URL</b> 和 <b>anon public key</b>。</li>' +
      '    <li>回到这里填入，并自己编一个同步码。完成！</li>' +
      '  </ol>' +
      '  <div class="cys-sql-head">' +
      '    <span>建表 SQL</span>' +
      '    <button class="cys-btn-sec cys-copy" id="cysCopySql">复制</button>' +
      '  </div>' +
      '  <pre class="cys-sql">' + escapeHtml(SQL_TEXT) + '</pre>' +
      '  <div class="cys-hint">注意：同步码等同于数据密码，别用太短的；在公共电脑上用完记得清除本机配置。</div>' +
      '</details>';

    body.querySelector('#cysCancel').addEventListener('click', function () {
      if (getConfig()) { state.modalMode = 'status'; renderModalBody(); }
      else closeModal();
    });

    body.querySelector('#cysCopySql').addEventListener('click', function () {
      var btn = this;
      function done() { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(SQL_TEXT).then(done, function () { fallbackCopy(); done(); });
      } else {
        fallbackCopy();
        done();
      }
      function fallbackCopy() {
        var ta = document.createElement('textarea');
        ta.value = SQL_TEXT;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
        ta.remove();
      }
    });

    body.querySelector('#cysSave').addEventListener('click', function () {
      var url = normUrl(body.querySelector('#cysUrl').value);
      var key = body.querySelector('#cysKey').value.trim();
      var code = body.querySelector('#cysCode').value.trim();
      var auto = body.querySelector('#cysAuto2').checked;

      if (!url || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.replace(/^https?:\/\//i, ''))) {
        toast('请填写正确的 Supabase 项目地址', 'err');
        return;
      }
      if (!key) { toast('请填写 anon 公钥', 'err'); return; }
      if (!code || code.length < 6) { toast('同步码至少 6 位，建议 12 位以上随机字符', 'err'); return; }

      rawSetItem(CONFIG_KEY, JSON.stringify({ url: url, key: key, code: code, autoSync: auto }));
      // 同步码变了，旧的云端快照作废
      if (cfg.code && cfg.code !== code) {
        rawRemoveItem(CLOUD_CACHE_KEY);
        state.lastCloudMap = null;
      }
      setDot('ok');
      resetTimers();
      toast('已保存，正在连接…');
      syncNow({ manual: true }).then(function () {
        if (state.lastResult && state.lastResult.ok) {
          state.modalMode = 'status';
          renderModalBody();
        }
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- Toast ---------------- */

  var toastTimer = null;

  function toast(msg, type) {
    var el = document.getElementById('cysToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cysToast';
      el.className = 'cys-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.setAttribute('data-type', type || 'info');
    el.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.style.display = 'none';
    }, 2600);
  }

  /* ---------------- 定时器与生命周期 ---------------- */

  var intervalTimer = null;

  function resetTimers() {
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    var cfg = getConfig();
    if (cfg && cfg.autoSync !== false) {
      intervalTimer = setInterval(function () {
        if (state.pendingReload && !isEditing()) {
          state.pendingReload = false;
          location.reload();
          return;
        }
        syncNow({ silent: true });
      }, 30000);
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    var cfg = getConfig();
    if (!cfg) return;
    if (cfg.autoSync === false) return;
    if (Date.now() - state.lastSyncAt > 10000) {
      syncNow({ silent: true });
    }
  });

  window.addEventListener('beforeunload', function () {
    var cfg = getConfig();
    if (!cfg || state.syncing) return;
    // 关页前把「本地比云端新」的 key 推上去（尽力而为，只推差量，不覆盖云端新数据）
    var cloudMap = state.lastCloudMap;
    if (!cloudMap) return; // 从未成功拉取过云端，不盲推
    var meta = getMeta();
    var rows = [];
    SYNC_KEYS.forEach(function (k) {
      var v = localStorage.getItem(k);
      var t = meta[k] || 0;
      if (v === null && !t) return;
      var c = cloudMap[k];
      if (!c || t > c.t) {
        rows.push({ code: cfg.code, key: k, value: v, t: t });
      }
    });
    if (!rows.length) return;
    try {
      fetch(normUrl(cfg.url) + '/rest/v1/' + TABLE, {
        method: 'POST',
        headers: apiHeaders(cfg, { 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(rows),
        keepalive: true
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  });

  /* ---------------- 样式 ---------------- */

  function injectStyles() {
    var css = [
      '.cys-area { margin-top: auto; padding-top: 16px; }',
      '.cys-btn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: none; border-radius: 8px; background: transparent; font-size: 14px; color: #666; cursor: pointer; font-family: inherit; transition: all .15s ease; }',
      '.cys-btn:hover { background: #f5f5f5; color: #111; }',
      '.cys-dot { margin-left: auto; width: 8px; height: 8px; border-radius: 50%; background: #ccc; flex-shrink: 0; }',
      '.cys-dot[data-state="syncing"] { background: #2563eb; animation: cysPulse 1s infinite; }',
      '.cys-dot[data-state="ok"] { background: #22c55e; }',
      '.cys-dot[data-state="err"] { background: #ef4444; }',
      '@keyframes cysPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }',
      '.cys-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 1200; display: flex; align-items: flex-end; justify-content: center; }',
      '.cys-mask { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.4); }',
      '.cys-sheet { position: relative; width: 100%; max-width: 460px; background: #fff; border-radius: 16px 16px 0 0; padding: 20px; box-sizing: border-box; animation: cysSlideUp .25s ease; max-height: 85vh; overflow-y: auto; }',
      '@keyframes cysSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }',
      '.cys-sheet-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }',
      '.cys-title { font-size: 18px; font-weight: 600; }',
      '.cys-close { border: none; background: none; font-size: 24px; line-height: 1; color: #999; cursor: pointer; padding: 0 4px; }',
      '.cys-close:hover { color: #111; }',
      '.cys-info { border: 1px solid #eee; border-radius: 10px; padding: 4px 14px; margin-bottom: 14px; }',
      '.cys-row { display: flex; justify-content: space-between; align-items: center; padding: 9px 0; font-size: 13px; border-bottom: 1px solid #f5f5f5; }',
      '.cys-row:last-child { border-bottom: none; }',
      '.cys-row span { color: #999; }',
      '.cys-row b { font-weight: 500; color: #111; max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.cys-st-ok { color: #16a34a; }',
      '.cys-st-err { color: #ef4444; }',
      '.cys-st-syncing { color: #2563eb; }',
      '.cys-field { margin-bottom: 12px; }',
      '.cys-field label { display: block; font-size: 12px; color: #999; margin-bottom: 5px; }',
      '.cys-field input { width: 100%; padding: 9px 10px; border: 1px solid #e5e5e5; border-radius: 8px; font-size: 13px; font-family: inherit; background: #fafafa; box-sizing: border-box; outline: none; transition: all .15s ease; }',
      '.cys-field input:focus { background: #fff; border-color: #111; }',
      '.cys-hint { font-size: 12px; color: #aaa; margin-top: 5px; line-height: 1.5; }',
      '.cys-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #555; margin: 14px 0; cursor: pointer; user-select: none; }',
      '.cys-check input { width: 15px; height: 15px; accent-color: #111; cursor: pointer; }',
      '.cys-actions { display: flex; gap: 10px; margin-bottom: 10px; }',
      '.cys-btn-pri { flex: 1; padding: 11px; background: #111; color: #fff; border: none; border-radius: 10px; font-size: 14px; cursor: pointer; font-family: inherit; }',
      '.cys-btn-pri:hover { opacity: .85; }',
      '.cys-btn-sec { flex: 1; padding: 11px; background: #fff; color: #111; border: 1px solid #e5e5e5; border-radius: 10px; font-size: 14px; cursor: pointer; font-family: inherit; }',
      '.cys-btn-sec:hover { background: #f5f5f5; }',
      '.cys-danger { color: #ef4444; }',
      '.cys-tip { font-size: 12px; color: #aaa; line-height: 1.6; margin-top: 4px; }',
      '.cys-tutorial { margin-top: 14px; font-size: 13px; }',
      '.cys-tutorial summary { cursor: pointer; color: #666; user-select: none; padding: 6px 0; }',
      '.cys-tutorial summary:hover { color: #111; }',
      '.cys-tutorial ol { margin: 8px 0 12px; padding-left: 18px; color: #555; line-height: 1.8; }',
      '.cys-tutorial a { color: #2563eb; }',
      '.cys-sql-head { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; }',
      '.cys-sql-head span { font-size: 12px; color: #999; }',
      '.cys-copy { flex: none; padding: 4px 12px; font-size: 12px; }',
      '.cys-sql { background: #1a1a1a; color: #e5e5e5; padding: 12px; border-radius: 10px; font-size: 11.5px; line-height: 1.55; overflow-x: auto; font-family: Consolas, Monaco, monospace; margin: 0 0 8px; }',
      '.cys-toast { position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%); background: rgba(17,17,17,.92); color: #fff; padding: 10px 18px; border-radius: 10px; font-size: 13px; z-index: 1300; max-width: 86vw; display: none; animation: cysFadeIn .2s ease; box-shadow: 0 4px 14px rgba(0,0,0,.18); }',
      '.cys-toast[data-type="err"] { background: rgba(190,18,60,.94); }',
      '.cys-toast[data-type="ok"] { background: rgba(21,128,61,.94); }',
      '@keyframes cysFadeIn { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }'
    ].join('\n');

    var style = document.createElement('style');
    style.id = 'cysStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    injectStyles();
    buildSidebarButton();
    resetTimers();

    var cfg = getConfig();
    if (cfg && cfg.autoSync !== false) {
      // 页面加载后稍等片刻再拉取，避免影响首屏速度
      setTimeout(function () { syncNow({ silent: true }); }, 1200);
    }

    // 调试接口
    window.CloudSync = {
      syncNow: syncNow,
      getConfig: getConfig
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

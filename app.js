/* FF Inventory SPA — vanilla JS, hash routing, talks to GAS web app via JSON POSTs. */

const state = {
  me: null,
  route: null,
  boot: null,       // bootstrap snapshot: { suppliers, items, onHand, lowStock, pos, counts, dashboard, ledger, users? }
  bootAt: 0,        // last bootstrap timestamp (ms)
  refreshing: false
};

const ROLES = { admin: 4, manager: 3, receiver: 2, viewer: 1 };
const can = (minRole) => state.me && ROLES[state.me.role] >= ROLES[minRole];

const ROUTES = [
  { hash: 'dashboard',  title: 'Dashboard',        icon: '▦', view: viewDashboard,  min: 'viewer' },
  { hash: 'inventory',  title: 'Inventory',        icon: '◉', view: viewInventory,  min: 'viewer' },
  { hash: 'lowstock',   title: 'Low Stock',        icon: '!', view: viewLowStock,   min: 'viewer' },
  { hash: 'items',      title: 'Items',            icon: '◆', view: viewItems,      min: 'viewer' },
  { hash: 'locations',  title: 'Locations',        icon: '⌂', view: viewLocations,  min: 'viewer' },
  { hash: 'suppliers',  title: 'Suppliers',        icon: '▤', view: viewSuppliers,  min: 'viewer' },
  { hash: 'po',         title: 'Purchase Orders',  icon: '▷', view: viewPOs,        min: 'viewer' },
  { hash: 'receiving',  title: 'Receiving',        icon: '↓', view: viewReceiving,  min: 'receiver' },
  { hash: 'ledger',     title: 'Ledger',           icon: '≡', view: viewLedger,     min: 'viewer' },
  { hash: 'counts',     title: 'Stock Counts',     icon: '☑', view: viewCounts,     min: 'viewer' },
  { hash: 'import',     title: 'Import',           icon: '⇪', view: viewImport,     min: 'manager' },
  { hash: 'users',      title: 'Users',            icon: '☻', view: viewUsers,      min: 'admin'  }
];

// ---------- API client ----------

// Cache for idempotent read endpoints. Key = action + JSON(payload). Value = {at, data}.
// Mutations call apiCacheBust() to clear it.
const _apiCache = new Map();
const _apiInflight = new Map();
const CACHEABLE = new Set([
  'me', 'dashboard.kpis', 'suppliers.list', 'items.list', 'items.lowStock',
  'po.list', 'count.list', 'users.list', 'inv.onHand'
]);
const CACHE_TTL_MS = 60 * 1000;

function apiCacheBust() { _apiCache.clear(); }

async function api(action, payload) {
  const userEmail = localStorage.getItem('ff_user_email') || '';
  const key = action + '|' + JSON.stringify(payload || {});
  const now = Date.now();

  // 1. Serve from cache for read-only actions.
  if (CACHEABLE.has(action)) {
    const hit = _apiCache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;
  }
  // 2. Dedupe simultaneous identical requests.
  if (_apiInflight.has(key)) return _apiInflight.get(key);

  const p = (async () => {
    const res = await fetch(window.CONFIG.API_URL, {
      method: 'POST',
      // Note: NO custom headers — avoids CORS preflight to GAS.
      body: JSON.stringify({ action, payload: payload || {}, user_email: userEmail })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Request failed');
    if (CACHEABLE.has(action)) _apiCache.set(key, { at: Date.now(), data: json.data });
    else apiCacheBust(); // any mutation invalidates the read cache
    return json.data;
  })().finally(() => _apiInflight.delete(key));

  _apiInflight.set(key, p);
  return p;
}

// ---------- Toast ----------

function toast(msg, kind = 'info') {
  const root = document.getElementById('toast-root');
  const colors = {
    success: 'bg-emerald-600',
    error:   'bg-rose-600',
    info:    'bg-slate-800'
  };
  const el = document.createElement('div');
  el.className = `toast ${colors[kind] || colors.info} text-white px-4 py-3 rounded-lg shadow-lg text-sm`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3000);
  setTimeout(() => el.remove(), 3400);
}

// ---------- Modal ----------

function modal(html, opts = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const widthClass = opts.wide ? 'modal modal-lg' : 'modal';
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="${widthClass}">
          <div class="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10 rounded-t-xl">
            <h3 class="font-semibold">${opts.title || ''}</h3>
            <button class="btn btn-ghost text-xl leading-none" data-close>×</button>
          </div>
          <div class="p-6">${html}</div>
        </div>
      </div>`;
    const close = (result) => {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    // Esc closes, Ctrl/Cmd+Enter saves (if a [data-save] button exists in the modal).
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const save = root.querySelector('.modal [data-save]');
        if (save) { e.preventDefault(); save.click(); }
      }
    };
    document.addEventListener('keydown', onKey);
    root.querySelector('[data-close]').onclick = () => close(null);
    root.querySelector('.modal-backdrop').onclick = (e) => { if (e.target === e.currentTarget) close(null); };
    const modalEl = root.querySelector('.modal');
    opts.onMount && opts.onMount(modalEl, close);
    // Auto-focus the first focusable input that isn't readonly/disabled.
    const focusTarget = modalEl.querySelector('input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), select:not([disabled])');
    if (focusTarget) setTimeout(() => focusTarget.focus(), 50);
  });
}

async function confirmDialog(message) {
  return modal(`
    <p class="text-sm text-slate-700 mb-5">${message}</p>
    <div class="flex justify-end gap-2">
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-danger" data-ok>Confirm</button>
    </div>
  `, {
    title: 'Confirm',
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = () => close(false);
      m.querySelector('[data-ok]').onclick = () => close(true);
    }
  });
}

// ---------- Auth boot ----------

async function boot() {
  if (!window.CONFIG || !window.CONFIG.API_URL || window.CONFIG.API_URL.includes('REPLACE_ME')) {
    document.getElementById('boot').innerHTML = `
      <div class="max-w-md p-6 bg-white rounded-xl shadow text-center">
        <h2 class="font-semibold text-lg mb-2">Configuration needed</h2>
        <p class="text-sm text-slate-600">Edit <code>web/config.js</code> and set <code>API_URL</code> to your deployed Apps Script <code>/exec</code> URL.</p>
      </div>`;
    return;
  }
  const stored = localStorage.getItem('ff_user_email');
  if (!stored) { showLogin(); return; }
  try {
    const data = await api('app.bootstrap');
    state.me = data.me;
    state.boot = data;
    state.bootAt = Date.now();
    showApp();
  } catch (err) {
    showLogin(err.message);
  }
}

/**
 * Re-fetch the bootstrap snapshot from the server. Called after any mutation,
 * by the Refresh button, and on a 5-min staleness check.
 */
async function bootRefresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  const btn = document.getElementById('refresh-btn');
  if (btn) { btn.textContent = '⟳'; btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    apiCacheBust();
    const data = await api('app.bootstrap');
    state.boot = data;
    state.bootAt = Date.now();
    if (state.route) state.route.view(document.getElementById('view'), true);
  } catch (err) {
    toast('Refresh failed: ' + err.message, 'error');
  } finally {
    state.refreshing = false;
    if (btn) { btn.textContent = '↻'; btn.disabled = false; btn.style.opacity = '1'; }
  }
}

function showLogin(msg) {
  document.getElementById('boot').classList.add('hidden');
  document.getElementById('app').classList.add('hidden');
  const login = document.getElementById('login');
  login.classList.remove('hidden');
  // Replace the inner card so the user can type an email.
  login.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full">
      <div class="text-center mb-6">
        <div class="w-14 h-14 rounded-xl bg-brand-600 mx-auto flex items-center justify-center text-white text-2xl font-bold">FF</div>
        <h1 class="text-2xl font-bold mt-3">FF Inventory</h1>
        <p class="text-slate-500 text-sm mt-1">Restaurant inventory management</p>
      </div>
      ${msg ? `<div class="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded p-2 mb-3">${msg}</div>` : ''}
      <label class="block mb-3">
        <span class="text-xs font-medium text-slate-600 uppercase tracking-wide">Email</span>
        <input id="login-email" class="input mt-1" type="email" placeholder="you@finandfin.com" value="${localStorage.getItem('ff_user_email') || ''}" />
      </label>
      <button id="login-btn" class="btn btn-primary w-full justify-center">Sign in</button>
      <p class="text-xs text-slate-400 mt-4 text-center">Your email must be added by an admin in the Users tab. First-time setup adds whoever runs <code>setup()</code> as admin.</p>
    </div>
  `;
  const emailInput = document.getElementById('login-email');
  emailInput.focus();
  const submit = async () => {
    const email = emailInput.value.trim().toLowerCase();
    if (!email || email.indexOf('@') < 0) { toast('Enter a valid email', 'error'); return; }
    localStorage.setItem('ff_user_email', email);
    try {
      // Call bootstrap (not 'me') so state.boot is populated before we render any view.
      const data = await api('app.bootstrap');
      state.me = data.me;
      state.boot = data;
      state.bootAt = Date.now();
      showApp();
    } catch (err) {
      localStorage.removeItem('ff_user_email');
      showLogin(err.message);
    }
  };
  document.getElementById('login-btn').onclick = submit;
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function signOut() {
  localStorage.removeItem('ff_user_email');
  state.me = null;
  location.hash = '';
  showLogin();
}

function showApp() {
  document.getElementById('boot').classList.add('hidden');
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  document.getElementById('me-name').textContent = state.me.name || state.me.email;
  document.getElementById('me-email').textContent = state.me.email;
  document.getElementById('me-role').textContent = state.me.role;
  // Wire sign-out
  const meRole = document.getElementById('me-role');
  if (!document.getElementById('signout-btn')) {
    const btn = document.createElement('button');
    btn.id = 'signout-btn';
    btn.className = 'mt-2 text-xs text-slate-400 hover:text-white underline';
    btn.textContent = 'Sign out';
    btn.onclick = signOut;
    meRole.parentNode.appendChild(btn);
  }

  renderNav();
  window.addEventListener('hashchange', router);
  document.getElementById('refresh-btn').onclick = () => bootRefresh();
  router();
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = ROUTES
    .filter(r => can(r.min))
    .map(r => `<a class="nav-link" href="#${r.hash}" data-route="${r.hash}"><span class="w-5 text-center">${r.icon}</span>${r.title}</a>`)
    .join('');
}

function router() {
  const hash = (location.hash || '#dashboard').slice(1).split('?')[0];
  let route = ROUTES.find(r => r.hash === hash) || ROUTES[0];
  if (!can(route.min)) route = ROUTES.find(r => can(r.min)) || ROUTES[0];
  state.route = route;
  document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.route === route.hash));
  document.getElementById('page-title').textContent = route.title;
  document.getElementById('page-sub').textContent = state.bootAt
    ? 'Last refreshed ' + fmtRelative(state.bootAt)
    : '';
  const v = document.getElementById('view');
  // Views read synchronously from state.boot — no spinner needed.
  try {
    route.view(v, false);
  } catch (err) {
    v.innerHTML = `<div class="bg-rose-50 text-rose-700 border border-rose-200 rounded-lg p-4">${escapeHtml(err.message)}</div>`;
  }
}

function fmtRelative(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

// ---------- helpers ----------

const fmtMoney = (n) => '₱' + (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n, d = 2) => (Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: d });
const fmtDate = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(iso); } };
const fmtDay  = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleDateString('en-PH', { dateStyle: 'medium' }); } catch { return String(iso); } };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function statusBadge(s) {
  const map = {
    draft: 'bg-slate-200 text-slate-700',
    sent: 'bg-blue-100 text-blue-700',
    partial: 'bg-amber-100 text-amber-800',
    received: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-rose-100 text-rose-700',
    in_progress: 'bg-amber-100 text-amber-800',
    completed: 'bg-emerald-100 text-emerald-700'
  };
  return `<span class="badge ${map[s] || 'bg-slate-100 text-slate-700'}">${s}</span>`;
}

function fieldset(label, html) {
  return `<label class="block mb-3"><span class="text-xs font-medium text-slate-600 uppercase tracking-wide">${label}</span><div class="mt-1">${html}</div></label>`;
}

// ---------- pagination + sort helpers ----------

/**
 * Apply filter, sort, and pagination to a row list. Pure function — caller manages state.
 * Returns { visible, total, totalPages, page, pageSize }.
 */
function paginateRows({ rows, filter, sortBy, sortDir = 'asc', page = 1, pageSize = 50 }) {
  let r = filter ? rows.filter(filter) : rows.slice();
  if (sortBy) {
    r.sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy];
      const cmp = (typeof av === 'number' && typeof bv === 'number')
        ? av - bv
        : String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv));
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }
  const total = r.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return { visible: r.slice(start, start + pageSize), total, totalPages, page: safePage, pageSize };
}

/** Renders pagination controls into a container element. */
function renderPaginator(rootEl, p, onChange) {
  const lo = p.total === 0 ? 0 : (p.page - 1) * p.pageSize + 1;
  const hi = Math.min(p.page * p.pageSize, p.total);
  rootEl.innerHTML = `
    <div class="flex items-center justify-between mt-3 text-sm flex-wrap gap-2 px-3 py-2 bg-slate-50 border-t border-slate-200 rounded-b-xl">
      <div class="text-slate-500">${p.total === 0 ? 'No rows' : `Showing <b>${lo}–${hi}</b> of <b>${p.total}</b>`}</div>
      <div class="flex items-center gap-2">
        <label class="text-slate-500 text-xs">Per page:</label>
        <select data-page-size class="input w-auto text-xs">
          ${[25, 50, 100, 250, 999999].map(n => `<option value="${n}" ${p.pageSize === n ? 'selected' : ''}>${n === 999999 ? 'All' : n}</option>`).join('')}
        </select>
        <button data-prev class="btn btn-secondary text-xs" ${p.page <= 1 ? 'disabled' : ''}>‹ Prev</button>
        <span class="text-slate-600 whitespace-nowrap text-xs">Page <b>${p.page}</b> / ${p.totalPages}</span>
        <button data-next class="btn btn-secondary text-xs" ${p.page >= p.totalPages ? 'disabled' : ''}>Next ›</button>
      </div>
    </div>`;
  rootEl.querySelector('[data-page-size]').onchange = (e) => onChange({ pageSize: Number(e.target.value), page: 1 });
  rootEl.querySelector('[data-prev]').onclick = () => onChange({ page: p.page - 1 });
  rootEl.querySelector('[data-next]').onclick = () => onChange({ page: p.page + 1 });
}

/** A sortable <th>. Click toggles between asc/desc. */
function sortableTh(label, key, sortBy, sortDir, extraClass = '') {
  const active = sortBy === key;
  const arrow = active ? `<span class="text-brand-600">${sortDir === 'asc' ? '▲' : '▼'}</span>` : '<span class="text-slate-300">▲</span>';
  return `<th data-sort="${key}" class="cursor-pointer hover:bg-slate-100 select-none ${extraClass}"><span class="inline-flex items-center gap-1">${label} <span class="text-[10px]">${arrow}</span></span></th>`;
}

/** Wire sortable headers within a table container; calls onChange with {sortBy, sortDir}. */
function bindSortable(tableEl, currentSortBy, currentSortDir, onChange) {
  tableEl.querySelectorAll('th[data-sort]').forEach(th => {
    th.onclick = () => {
      const key = th.dataset.sort;
      const nextDir = (currentSortBy === key && currentSortDir === 'asc') ? 'desc' : 'asc';
      onChange({ sortBy: key, sortDir: nextDir, page: 1 });
    };
  });
}

// ============================================================
// VIEWS
// ============================================================

// ---------- Dashboard ----------

function viewDashboard(root) {
  const k = state.boot.dashboard;
  root.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      ${kpiCard('Inventory Value', fmtMoney(k.inventory_value), 'across ' + k.active_skus + ' SKUs')}
      ${kpiCard('Low Stock', k.low_stock_count, 'items at or below reorder point', k.low_stock_count > 0 ? 'rose' : 'emerald')}
      ${kpiCard('Open POs', k.open_po_count, fmtMoney(k.open_po_value) + ' total')}
      ${kpiCard('Receipts (7d)', fmtMoney(k.receipts_7d), 'stock-in value')}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
      ${kpiCard('Issues / Waste (7d)', fmtMoney(k.issues_7d), 'stock-out value')}
      ${kpiCard('Adjustments (7d)', fmtMoney(k.adjustments_7d), 'absolute value')}
      ${kpiCard('Total Units', fmtNum(k.total_units), 'sum across all items')}
    </div>

    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div class="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
        <h3 class="font-semibold">Recent activity</h3>
        <a href="#ledger" class="text-xs text-brand-600 hover:underline">View full ledger →</a>
      </div>
      <table>
        <thead><tr><th>When</th><th>Item</th><th>Type</th><th class="text-right">Qty</th><th class="text-right">Value</th><th>By</th></tr></thead>
        <tbody>
          ${k.recent_txns.length === 0
            ? '<tr><td colspan="6" class="text-center text-slate-400 py-6">No transactions yet</td></tr>'
            : k.recent_txns.map(t => `
              <tr>
                <td class="text-slate-500">${fmtDate(t.txn_date)}</td>
                <td>${escapeHtml(t.item_name)}</td>
                <td><span class="badge bg-slate-100 text-slate-700">${t.type}</span></td>
                <td class="text-right ${t.qty < 0 ? 'text-rose-600' : 'text-emerald-700'}">${fmtNum(t.qty)}</td>
                <td class="text-right">${fmtMoney(t.total_cost)}</td>
                <td class="text-slate-500">${escapeHtml(t.by)}</td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function kpiCard(label, value, sub, tone = 'brand') {
  const tones = {
    brand: 'border-brand-500',
    rose: 'border-rose-500',
    emerald: 'border-emerald-500'
  };
  return `
    <div class="bg-white rounded-xl shadow-sm border-l-4 ${tones[tone]} border-t border-r border-b border-slate-200 p-5">
      <div class="text-xs uppercase tracking-wide text-slate-500 font-semibold">${label}</div>
      <div class="text-2xl font-bold mt-1">${value}</div>
      <div class="text-xs text-slate-500 mt-1">${sub}</div>
    </div>`;
}

// ---------- Inventory on-hand ----------

function viewInventory(root) {
  const rows = state.boot.onHand;
  const byLoc = state.boot.onHandByLocation || [];
  const locs = state.boot.locations || [];
  const totalValue = rows.reduce((s, r) => s + (r.value || 0), 0);
  // Per-location totals for the chip strip
  const locTotals = {};
  byLoc.forEach(r => { locTotals[r.location_id] = (locTotals[r.location_id] || 0) + (r.value || 0); });

  state.viewInv = state.viewInv || { filter: '', locationId: '', page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc' };
  const vs = state.viewInv;

  root.innerHTML = `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 mb-4 p-4">
      <div class="flex items-center justify-between mb-2">
        <h3 class="font-semibold">Value by location</h3>
        <div class="text-right">
          <div class="text-xs text-slate-500">Total value</div>
          <div class="font-bold text-lg">${fmtMoney(totalValue)}</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-2">
        ${locs.filter(l => l.active).map(l => `
          <div class="border border-slate-200 rounded-lg px-3 py-2 min-w-[8rem]">
            <div class="text-xs text-slate-500">${escapeHtml(l.name)}</div>
            <div class="font-semibold">${fmtMoney(locTotals[l.id] || 0)}</div>
          </div>`).join('') || '<div class="text-xs text-slate-400">No active locations yet.</div>'}
      </div>
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200">
      <div class="px-5 py-3 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
        <h3 class="font-semibold">On-hand inventory</h3>
        <div class="flex gap-2 flex-wrap items-center">
          <input id="inv-q" class="input max-w-xs" placeholder="Search…" value="${escapeHtml(vs.filter)}" />
          <select id="inv-loc-filter" class="input max-w-xs">
            <option value="">All locations (totals)</option>
            ${locs.filter(l => l.active).map(l => `<option value="${l.id}" ${vs.locationId === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <table id="inv-table">
        <thead><tr>
          ${sortableTh('SKU', 'sku', vs.sortBy, vs.sortDir)}
          ${sortableTh('Name', 'name', vs.sortBy, vs.sortDir)}
          ${sortableTh('Unit', 'unit', vs.sortBy, vs.sortDir)}
          ${sortableTh('On hand', 'on_hand', vs.sortBy, vs.sortDir, 'text-right')}
          ${sortableTh('Avg cost', 'avg_cost', vs.sortBy, vs.sortDir, 'text-right')}
          ${sortableTh('Value', 'value', vs.sortBy, vs.sortDir, 'text-right')}
          <th></th>
        </tr></thead>
        <tbody id="inv-tbody"></tbody>
      </table>
      <div id="inv-pager"></div>
    </div>
  `;
  const itemById = {};
  rows.forEach(r => { itemById[r.item_id] = r; });

  const render = () => {
    // Build the row set
    let base;
    if (!vs.locationId) {
      base = rows;
    } else {
      base = byLoc.filter(b => b.location_id === vs.locationId).map(b => {
        const meta = itemById[b.item_id] || { sku: '', name: '(unknown)', unit: '' };
        return {
          item_id: b.item_id, sku: meta.sku, name: meta.name, unit: meta.unit,
          on_hand: b.qty, avg_cost: b.avg_cost, value: b.value
        };
      });
    }
    const q = vs.filter.toLowerCase();
    const p = paginateRows({
      rows: base,
      filter: q ? r => (r.name + ' ' + r.sku).toLowerCase().includes(q) : null,
      sortBy: vs.sortBy, sortDir: vs.sortDir,
      page: vs.page, pageSize: vs.pageSize
    });
    vs.page = p.page;
    document.getElementById('inv-tbody').innerHTML = p.visible.length === 0
      ? '<tr><td colspan="7" class="text-center text-slate-400 py-6">No items</td></tr>'
      : p.visible.map(r => `
        <tr>
          <td class="text-slate-500 font-mono text-xs">${escapeHtml(r.sku)}</td>
          <td class="font-medium">${escapeHtml(r.name)}</td>
          <td class="text-slate-500">${escapeHtml(r.unit)}</td>
          <td class="text-right ${r.on_hand < 0 ? 'text-rose-600' : ''}">${fmtNum(r.on_hand)}</td>
          <td class="text-right">${fmtMoney(r.avg_cost)}</td>
          <td class="text-right font-medium">${fmtMoney(r.value)}</td>
          <td class="text-right">${can('manager')
            ? `<button class="btn btn-ghost text-xs" data-adj="${r.item_id}">Adjust</button>`
            : ''}</td>
        </tr>`).join('');
    document.querySelectorAll('[data-adj]').forEach(btn => {
      btn.onclick = () => openAdjustModal(btn.dataset.adj);
    });
    renderPaginator(document.getElementById('inv-pager'), p, (delta) => { Object.assign(vs, delta); render(); });
    bindSortable(document.getElementById('inv-table'), vs.sortBy, vs.sortDir, (delta) => { Object.assign(vs, delta); render(); });
  };
  document.getElementById('inv-q').oninput = (e) => { vs.filter = e.target.value; vs.page = 1; render(); };
  document.getElementById('inv-loc-filter').onchange = (e) => { vs.locationId = e.target.value; vs.page = 1; render(); };
  render();
}

async function openAdjustModal(itemId) {
  // Use the on-hand snapshot for current qty/avg_cost; falls back to items list for name/unit.
  const itemMeta = state.boot.items.find(i => i.id === itemId) || {};
  const stock = state.boot.onHand.find(o => o.item_id === itemId) || {};
  const item = { ...itemMeta, on_hand: stock.on_hand || 0, avg_cost: stock.avg_cost || 0 };
  const locs = (state.boot.locations || []).filter(l => l.active);
  const html = `
    <div class="text-sm text-slate-600 mb-3">
      Adjusting <b>${escapeHtml(item.name)}</b> — current on hand: <b>${fmtNum(item.on_hand)} ${escapeHtml(item.unit)}</b>
    </div>
    ${fieldset('Location', `<select class="input" name="location_id">
      ${locs.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
    </select>`)}
    ${fieldset('Type', `<select class="input" name="type">
      <option value="adjustment">Adjustment</option>
      <option value="waste">Waste</option>
    </select>`)}
    ${fieldset('Qty (signed: + adds, − removes)', '<input class="input" type="number" step="any" name="qty" />')}
    ${fieldset('Unit cost (optional — defaults to current WAC)', `<input class="input" type="number" step="any" name="unit_cost" placeholder="${fmtNum(item.avg_cost)}" />`)}
    ${fieldset('Reason / notes', '<textarea class="input" rows="2" name="notes" required></textarea>')}
    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>Post adjustment</button>
    </div>`;
  await modal(html, {
    title: 'Adjust inventory',
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = () => close(null);
      m.querySelector('[data-save]').onclick = async () => {
        const get = (n) => m.querySelector(`[name="${n}"]`).value;
        try {
          await api('inv.adjust', {
            item_id: itemId,
            location_id: get('location_id'),
            type: get('type'),
            qty: Number(get('qty')),
            unit_cost: get('unit_cost') === '' ? undefined : Number(get('unit_cost')),
            notes: get('notes')
          });
          toast('Adjustment posted', 'success');
          close(true);
          bootRefresh();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

// ---------- Low stock ----------

function viewLowStock(root) {
  const rows = state.boot.lowStock;
  root.innerHTML = `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200">
      <div class="px-5 py-3 border-b border-slate-200">
        <h3 class="font-semibold">Items at or below reorder point</h3>
        <p class="text-xs text-slate-500">Only items with a non-zero reorder point are tracked here.</p>
      </div>
      <table>
        <thead><tr><th>SKU</th><th>Name</th><th>Unit</th><th class="text-right">On hand</th><th class="text-right">Reorder pt</th><th class="text-right">Suggested order</th></tr></thead>
        <tbody>
          ${rows.length === 0
            ? '<tr><td colspan="6" class="text-center text-emerald-600 py-6">All items above reorder point ✓</td></tr>'
            : rows.map(r => `
              <tr>
                <td class="text-slate-500">${escapeHtml(r.sku)}</td>
                <td class="font-medium">${escapeHtml(r.name)}</td>
                <td class="text-slate-500">${escapeHtml(r.unit)}</td>
                <td class="text-right text-rose-600 font-medium">${fmtNum(r.on_hand)}</td>
                <td class="text-right">${fmtNum(r.reorder_point)}</td>
                <td class="text-right">${fmtNum(r.reorder_qty || Math.max(r.par_level - r.on_hand, 0))}</td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ---------- Items ----------

function viewItems(root) {
  const rows = state.boot.items;
  // Persist view state across re-renders within this session (filter survives bootRefresh).
  state.viewItems = state.viewItems || { filter: '', page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc' };
  const vs = state.viewItems;

  root.innerHTML = `
    <div class="flex justify-between items-center mb-4 gap-2 flex-wrap">
      <input id="items-q" class="input max-w-sm" placeholder="Search by name, SKU, brand, supplier, category…" value="${escapeHtml(vs.filter)}" />
      <div class="flex gap-2">
        ${can('admin') ? '<button class="btn btn-ghost text-rose-600 text-xs" id="wipe-items" title="Delete all items (only if no transactions yet)">Wipe all</button>' : ''}
        ${can('manager') ? '<button class="btn btn-primary" id="new-item">+ New item</button>' : ''}
      </div>
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-auto">
      <table id="items-table">
        <thead><tr>
          ${sortableTh('SKU', 'sku', vs.sortBy, vs.sortDir)}
          ${sortableTh('Name', 'name', vs.sortBy, vs.sortDir)}
          ${sortableTh('Brand', 'brand', vs.sortBy, vs.sortDir)}
          ${sortableTh('Category', 'category', vs.sortBy, vs.sortDir)}
          ${sortableTh('Unit', 'unit', vs.sortBy, vs.sortDir)}
          ${sortableTh('Suppliers', 'supplier_count', vs.sortBy, vs.sortDir, 'text-right')}
          ${sortableTh('Best ₱/unit', 'best_unit_cost', vs.sortBy, vs.sortDir, 'text-right')}
          ${sortableTh('Preferred ₱/unit', 'preferred_unit_cost', vs.sortBy, vs.sortDir, 'text-right')}
          ${sortableTh('On hand', 'on_hand', vs.sortBy, vs.sortDir, 'text-right')}
          ${sortableTh('WAC', 'avg_cost', vs.sortBy, vs.sortDir, 'text-right')}
          <th></th>
        </tr></thead>
        <tbody id="items-tbody"></tbody>
      </table>
      <div id="items-pager"></div>
    </div>`;

  const render = () => {
    const q = vs.filter.toLowerCase();
    const p = paginateRows({
      rows,
      filter: q
        ? r => (r.name + ' ' + r.sku + ' ' + r.brand + ' ' + r.category + ' ' + r.default_supplier_name + ' ' + (r.supplier_prices || []).map(sp => sp.supplier_name).join(' ')).toLowerCase().includes(q)
        : null,
      sortBy: vs.sortBy, sortDir: vs.sortDir,
      page: vs.page, pageSize: vs.pageSize
    });
    vs.page = p.page;
    document.getElementById('items-tbody').innerHTML = p.visible.length === 0
      ? '<tr><td colspan="11" class="text-center text-slate-400 py-6">No items</td></tr>'
      : p.visible.map(r => `
        <tr>
          <td class="text-slate-500 font-mono text-xs">${escapeHtml(r.sku)}</td>
          <td class="font-medium">${escapeHtml(r.name)} ${!r.active ? '<span class="badge bg-slate-100 text-slate-500 ml-1">inactive</span>' : ''}</td>
          <td class="text-slate-500">${escapeHtml(r.brand)}</td>
          <td class="text-slate-500">${escapeHtml(r.category)}${r.subcategory ? ' / ' + escapeHtml(r.subcategory) : ''}</td>
          <td class="text-slate-500">${escapeHtml(r.unit)}</td>
          <td class="text-right ${r.supplier_count === 0 ? 'text-slate-300' : ''}">${r.supplier_count}</td>
          <td class="text-right">${r.best_unit_cost ? fmtMoney(r.best_unit_cost) : '<span class="text-slate-300">—</span>'}</td>
          <td class="text-right text-slate-500" title="${escapeHtml(r.default_supplier_name || 'no preferred supplier — showing best')}">${r.preferred_unit_cost ? fmtMoney(r.preferred_unit_cost) : '<span class="text-slate-300">—</span>'}</td>
          <td class="text-right">${fmtNum(r.on_hand)}</td>
          <td class="text-right">${fmtMoney(r.avg_cost)}</td>
          <td class="text-right whitespace-nowrap">
            ${can('manager') ? `<button class="btn btn-ghost text-xs" data-edit="${r.id}">Edit</button>` : ''}
            ${can('manager') ? `<button class="btn btn-ghost text-xs text-rose-600" data-del="${r.id}">Del</button>` : ''}
          </td>
        </tr>`).join('');
    document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openItemModal(b.dataset.edit));
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteItem(b.dataset.del));
    renderPaginator(document.getElementById('items-pager'), p, (delta) => { Object.assign(vs, delta); render(); });
    bindSortable(document.getElementById('items-table'), vs.sortBy, vs.sortDir, (delta) => { Object.assign(vs, delta); render(); });
  };

  document.getElementById('items-q').oninput = (e) => { vs.filter = e.target.value; vs.page = 1; render(); };
  if (can('manager')) document.getElementById('new-item').onclick = () => openItemModal();
  if (can('admin')) document.getElementById('wipe-items').onclick = async () => {
    if (!(await confirmDialog('Wipe ALL items, supplier prices, and stock state? Refuses if any inventory transactions exist.'))) return;
    try { const r = await api('items.wipeAll', {}); toast(r, 'success'); bootRefresh(); }
    catch (e) { toast(e.message, 'error'); }
  };
  render();
}

async function openItemModal(id) {
  // Read from bootstrap cache instead of a fresh items.get round-trip.
  const existing = id ? (state.boot.items.find(i => i.id === id) || {}) : {};
  const suppliers = (state.boot.suppliers || []).filter(s => s.active);
  // Working copy of supplier prices we'll mutate inside the modal
  const prices = (existing.supplier_prices || []).map(p => ({ ...p }));

  const priceRowHtml = (p, idx) => `
    <tr data-pidx="${idx}">
      <td>
        <select class="input" data-f="supplier_id">
          <option value="">— pick supplier —</option>
          ${suppliers.map(s => `<option value="${s.id}" ${p.supplier_id === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </td>
      <td><input class="input" data-f="pack_size" value="${escapeHtml(p.pack_size || '')}" placeholder="1 KG" /></td>
      <td><input class="input text-right" type="number" step="any" data-f="pack_qty" value="${p.pack_qty || ''}" placeholder="qty" /></td>
      <td><input class="input text-right" type="number" step="any" data-f="pack_cost" value="${p.pack_cost || ''}" placeholder="cost" /></td>
      <td class="text-right text-slate-500 unit-cost-cell">—</td>
      <td><button class="btn btn-ghost text-rose-600 text-xs" data-rm>×</button></td>
    </tr>`;

  const html = `
    <div class="grid grid-cols-2 gap-3">
      ${fieldset('Name *', `<input class="input" name="name" value="${escapeHtml(existing.name || '')}" required />`)}
      ${fieldset('SKU (blank = auto)', `<input class="input font-mono" name="sku" value="${escapeHtml(existing.sku || '')}" placeholder="RAW-0001 (auto if blank)" />`)}
      ${fieldset('Brand', `<input class="input" name="brand" value="${escapeHtml(existing.brand || '')}" />`)}
      ${fieldset('Category', `<input class="input" name="category" value="${escapeHtml(existing.category || '')}" placeholder="RAW ING, SUPPLIES, SUB-RECIPE…" />`)}
      ${fieldset('Subcategory', `<input class="input" name="subcategory" value="${escapeHtml(existing.subcategory || '')}" placeholder="Protein, Produce, Dairy…" />`)}
      ${fieldset('Base unit *', `<input class="input" name="unit" value="${escapeHtml(existing.unit || '')}" placeholder="g, ml, pc…" required />`)}
      ${fieldset('Yield %', `<input class="input" type="number" step="any" name="yield_pct" value="${existing.yield_pct || 100}" title="Usable % after trim. 100 = no loss." />`)}
      ${fieldset('Preferred supplier', `<select class="input" name="default_supplier_id">
        <option value="">— none (use cheapest) —</option>
        ${suppliers.map(s => `<option value="${s.id}" ${existing.default_supplier_id === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
      </select>`)}
    </div>

    <div class="bg-slate-50 border border-slate-200 rounded-lg p-3 my-3">
      <div class="flex justify-between items-center mb-2">
        <div class="text-xs font-medium text-slate-600 uppercase tracking-wide">Suppliers &amp; Prices</div>
        <button class="btn btn-secondary text-xs" id="add-price">+ Add supplier price</button>
      </div>
      <table class="border border-slate-200 rounded bg-white">
        <thead><tr><th>Supplier</th><th>Pack</th><th class="text-right">Pack qty</th><th class="text-right">Pack cost</th><th class="text-right">Effective ₱/unit</th><th></th></tr></thead>
        <tbody id="prices-tbody">
          ${prices.map(priceRowHtml).join('')}
        </tbody>
      </table>
      <p class="text-xs text-slate-500 mt-2">Effective ₱/unit = pack_cost ÷ (pack_qty × yield%). Changing a price creates a new history row; cosmetic edits patch in place.</p>
    </div>

    <div class="grid grid-cols-4 gap-3">
      ${fieldset('Par level', `<input class="input" type="number" step="any" name="par_level" value="${existing.par_level || 0}" />`)}
      ${fieldset('Reorder point', `<input class="input" type="number" step="any" name="reorder_point" value="${existing.reorder_point || 0}" />`)}
      ${fieldset('Reorder qty', `<input class="input" type="number" step="any" name="reorder_qty" value="${existing.reorder_qty || 0}" />`)}
      ${fieldset('Barcode', `<input class="input" name="barcode" value="${escapeHtml(existing.barcode || '')}" />`)}
    </div>
    ${fieldset('Notes', `<textarea class="input" rows="2" name="notes">${escapeHtml(existing.notes || '')}</textarea>`)}
    <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" name="active" ${existing.id === undefined || existing.active ? 'checked' : ''} /> Active</label>
    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>Save</button>
    </div>`;

  await modal(html, {
    title: id ? 'Edit item' : 'New item',
    wide: true,
    onMount: (m, close) => {
      const tbody = m.querySelector('#prices-tbody');
      const yieldInput = m.querySelector('[name="yield_pct"]');
      let counter = prices.length;

      const recalcUnitCosts = () => {
        const y = (Number(yieldInput.value) || 100) / 100;
        tbody.querySelectorAll('tr').forEach(tr => {
          const q = Number(tr.querySelector('[data-f="pack_qty"]').value) || 0;
          const c = Number(tr.querySelector('[data-f="pack_cost"]').value) || 0;
          tr.querySelector('.unit-cost-cell').textContent =
            (q > 0 && c > 0) ? fmtMoney(c / (q * y)) : '—';
        });
      };
      const bindRow = (tr) => {
        tr.querySelectorAll('input, select').forEach(el => el.oninput = recalcUnitCosts);
        tr.querySelector('[data-rm]').onclick = () => { tr.remove(); recalcUnitCosts(); };
      };
      tbody.querySelectorAll('tr').forEach(bindRow);
      yieldInput.oninput = recalcUnitCosts;
      recalcUnitCosts();

      m.querySelector('#add-price').onclick = () => {
        const div = document.createElement('tbody');
        div.innerHTML = priceRowHtml({ supplier_id: '', pack_size: '', pack_qty: '', pack_cost: '' }, counter++);
        const tr = div.querySelector('tr');
        tbody.appendChild(tr);
        bindRow(tr);
        recalcUnitCosts();
      };

      m.querySelector('[data-cancel]').onclick = () => close(null);
      m.querySelector('[data-save]').onclick = async () => {
        const get = (n) => m.querySelector(`[name="${n}"]`).value;
        // Gather prices from the table
        const pricesOut = Array.from(tbody.querySelectorAll('tr')).map((tr, i) => ({
          id: prices[Number(tr.dataset.pidx)] ? prices[Number(tr.dataset.pidx)].id : undefined,
          supplier_id: tr.querySelector('[data-f="supplier_id"]').value,
          pack_size: tr.querySelector('[data-f="pack_size"]').value,
          pack_qty: Number(tr.querySelector('[data-f="pack_qty"]').value) || 0,
          pack_cost: Number(tr.querySelector('[data-f="pack_cost"]').value) || 0
        })).filter(p => p.supplier_id && p.pack_qty > 0 && p.pack_cost >= 0);

        const payload = {
          item: {
            id: id,
            sku: get('sku'), name: get('name'),
            category: get('category'), subcategory: get('subcategory'),
            unit: get('unit'),
            brand: get('brand'),
            default_supplier_id: get('default_supplier_id'),
            yield_pct: Number(get('yield_pct')) || 100,
            par_level: Number(get('par_level')),
            reorder_point: Number(get('reorder_point')),
            reorder_qty: Number(get('reorder_qty')),
            barcode: get('barcode'), notes: get('notes'),
            active: m.querySelector('[name="active"]').checked
          },
          prices: pricesOut
        };
        try {
          await api('items.upsertWithPrices', payload);
          toast('Saved', 'success');
          close(true);
          bootRefresh();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

async function deleteItem(id) {
  if (!(await confirmDialog('Delete this item? It will be hidden from lists; the audit log is retained.'))) return;
  try { await api('items.delete', { id }); toast('Deleted', 'success'); bootRefresh(); }
  catch (e) { toast(e.message, 'error'); }
}

// ---------- Suppliers ----------

function viewSuppliers(root) {
  const rows = state.boot.suppliers;
  root.innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <input id="sup-q" class="input max-w-sm" placeholder="Search…" />
      <div class="flex gap-2">
        ${can('admin') ? '<button class="btn btn-ghost text-rose-600 text-xs" id="wipe-suppliers" title="Delete all suppliers + prices. Refuses if any POs exist.">Wipe all</button>' : ''}
        ${can('manager') ? '<button class="btn btn-primary" id="new-sup">+ New supplier</button>' : ''}
      </div>
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th><th>Terms</th><th></th></tr></thead>
        <tbody id="sup-tbody"></tbody>
      </table>
    </div>`;
  const render = (filter) => {
    const q = (filter || '').toLowerCase();
    const filtered = rows.filter(r => !q || (r.name + ' ' + r.code + ' ' + r.contact_name).toLowerCase().includes(q));
    document.getElementById('sup-tbody').innerHTML = filtered.length === 0
      ? '<tr><td colspan="7" class="text-center text-slate-400 py-6">No suppliers</td></tr>'
      : filtered.map(r => `
        <tr>
          <td class="text-slate-500">${escapeHtml(r.code)}</td>
          <td class="font-medium">${escapeHtml(r.name)} ${!r.active ? '<span class="badge bg-slate-100 text-slate-500 ml-1">inactive</span>' : ''}</td>
          <td>${escapeHtml(r.contact_name)}</td>
          <td class="text-slate-500">${escapeHtml(r.phone)}</td>
          <td class="text-slate-500">${escapeHtml(r.email)}</td>
          <td class="text-slate-500">${escapeHtml(r.payment_terms)}</td>
          <td class="text-right">
            ${can('manager') ? `<button class="btn btn-ghost text-xs" data-edit="${r.id}">Edit</button>` : ''}
            ${can('manager') ? `<button class="btn btn-ghost text-xs text-rose-600" data-del="${r.id}">Del</button>` : ''}
          </td>
        </tr>`).join('');
    document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openSupplierModal(b.dataset.edit));
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteSupplier(b.dataset.del));
  };
  document.getElementById('sup-q').oninput = (e) => render(e.target.value);
  if (can('manager')) document.getElementById('new-sup').onclick = () => openSupplierModal();
  if (can('admin')) document.getElementById('wipe-suppliers').onclick = async () => {
    if (!(await confirmDialog('Wipe ALL suppliers + supplier prices? Items lose their default-supplier link. Refuses if any POs exist.'))) return;
    try { const r = await api('suppliers.wipeAll', {}); toast(r, 'success'); bootRefresh(); }
    catch (e) { toast(e.message, 'error'); }
  };
  render('');
}

async function openSupplierModal(id) {
  // Read from bootstrap cache instead of a fresh suppliers.get round-trip.
  const e = id ? (state.boot.suppliers.find(s => s.id === id) || {}) : {};
  const html = `
    <div class="grid grid-cols-2 gap-3">
      ${fieldset('Code', `<input class="input" name="code" value="${escapeHtml(e.code || '')}" />`)}
      ${fieldset('Name *', `<input class="input" name="name" value="${escapeHtml(e.name || '')}" required />`)}
      ${fieldset('Contact name', `<input class="input" name="contact_name" value="${escapeHtml(e.contact_name || '')}" />`)}
      ${fieldset('Email', `<input class="input" type="email" name="email" value="${escapeHtml(e.email || '')}" />`)}
      ${fieldset('Phone', `<input class="input" name="phone" value="${escapeHtml(e.phone || '')}" />`)}
      ${fieldset('Payment terms', `<input class="input" name="payment_terms" value="${escapeHtml(e.payment_terms || '')}" placeholder="Net 30, COD…" />`)}
    </div>
    ${fieldset('Address', `<textarea class="input" rows="2" name="address">${escapeHtml(e.address || '')}</textarea>`)}
    ${fieldset('Notes', `<textarea class="input" rows="2" name="notes">${escapeHtml(e.notes || '')}</textarea>`)}
    <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" name="active" ${e.id === undefined || e.active ? 'checked' : ''} /> Active</label>
    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>Save</button>
    </div>`;
  await modal(html, {
    title: id ? 'Edit supplier' : 'New supplier',
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = () => close(null);
      m.querySelector('[data-save]').onclick = async () => {
        const get = (n) => m.querySelector(`[name="${n}"]`).value;
        try {
          await api('suppliers.upsert', {
            id, code: get('code'), name: get('name'),
            contact_name: get('contact_name'), email: get('email'), phone: get('phone'),
            address: get('address'), payment_terms: get('payment_terms'), notes: get('notes'),
            active: m.querySelector('[name="active"]').checked
          });
          toast('Saved', 'success');
          close(true);
          bootRefresh();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

async function deleteSupplier(id) {
  if (!(await confirmDialog('Delete this supplier?'))) return;
  try { await api('suppliers.delete', { id }); toast('Deleted', 'success'); bootRefresh(); }
  catch (e) { toast(e.message, 'error'); }
}

// ---------- Purchase Orders ----------

function viewPOs(root) {
  const rows = state.boot.pos;
  root.innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <input id="po-q" class="input max-w-sm" placeholder="Search by PO# or supplier…" />
      ${can('manager') ? '<button class="btn btn-primary" id="new-po">+ New PO</button>' : ''}
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table>
        <thead><tr><th>PO #</th><th>Supplier</th><th>Status</th><th>Order date</th><th>Expected</th><th class="text-right">Total</th><th></th></tr></thead>
        <tbody id="po-tbody"></tbody>
      </table>
    </div>`;
  const render = (filter) => {
    const q = (filter || '').toLowerCase();
    const filtered = rows.filter(r => !q || (r.po_number + ' ' + r.supplier_name).toLowerCase().includes(q));
    document.getElementById('po-tbody').innerHTML = filtered.length === 0
      ? '<tr><td colspan="7" class="text-center text-slate-400 py-6">No POs</td></tr>'
      : filtered.map(r => `
        <tr>
          <td class="font-medium">${escapeHtml(r.po_number)}</td>
          <td>${escapeHtml(r.supplier_name)}</td>
          <td>${statusBadge(r.status)}</td>
          <td class="text-slate-500">${fmtDay(r.order_date)}</td>
          <td class="text-slate-500">${fmtDay(r.expected_date)}</td>
          <td class="text-right font-medium">${fmtMoney(r.total)}</td>
          <td class="text-right"><button class="btn btn-ghost text-xs" data-view="${r.id}">Open</button></td>
        </tr>`).join('');
    document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => openPOModal(b.dataset.view));
  };
  document.getElementById('po-q').oninput = (e) => render(e.target.value);
  if (can('manager')) document.getElementById('new-po').onclick = () => openPOEditor();
  render('');
}

async function openPOEditor(id) {
  // suppliers + items come from the bootstrap snapshot; only PO lines need a fresh fetch.
  const suppliers = (state.boot.suppliers || []).filter(s => s.active);
  const items = state.boot.items || [];
  if (!suppliers.length) {
    toast('Add at least one active supplier first', 'error');
    return;
  }
  if (!items.length) {
    toast('Add at least one item first', 'error');
    return;
  }
  const existing = id ? await api('po.get', { id }) : null;
  const lines = existing ? existing.lines.map(l => ({ ...l })) : [];

  // If any PO line references a deleted item, include a synthetic option so the dropdown
  // shows it instead of silently swapping it to the first item on save.
  const itemById = {};
  items.forEach(i => { itemById[i.id] = i; });
  const ghostItems = [];
  lines.forEach(l => {
    if (l.item_id && !itemById[l.item_id]) {
      ghostItems.push({ id: l.item_id, name: '(deleted) ' + (l.item_name || l.item_id), unit: l.unit || '' });
    }
  });
  const allItemOptions = ghostItems.concat(items);

  // Look up best supplier-specific unit cost for (item, supplier).
  // Returns cost per ONE base unit (pack_cost / pack_qty), suitable for the PO line unit_cost field.
  const supplierPriceFor = (itemId, supplierId) => {
    const it = itemById[itemId];
    if (!it || !it.supplier_prices || !supplierId) return null;
    const sp = it.supplier_prices.find(p => p.supplier_id === supplierId);
    if (!sp || !sp.pack_qty) return null;
    return sp.pack_cost / sp.pack_qty;
  };

  const lineRowHtml = (l, idx) => `
    <tr data-line="${idx}">
      <td>
        <select class="input" data-field="item_id">
          ${allItemOptions.map(it => `<option value="${it.id}" ${l.item_id === it.id ? 'selected' : ''}>${escapeHtml(it.name)} (${escapeHtml(it.unit || '')})</option>`).join('')}
        </select>
      </td>
      <td><input class="input text-right" type="number" step="any" data-field="qty_ordered" value="${l.qty_ordered || 1}" /></td>
      <td><input class="input text-right" type="number" step="any" data-field="unit_cost" value="${l.unit_cost || 0}" /></td>
      <td class="text-right line-total">${fmtMoney((l.qty_ordered || 0) * (l.unit_cost || 0))}</td>
      <td><button class="btn btn-ghost text-rose-600" data-rm>×</button></td>
    </tr>`;

  const html = `
    <div class="grid grid-cols-2 gap-3 mb-3">
      ${fieldset('Supplier *', `<select class="input" name="supplier_id" required>
        <option value="">— select —</option>
        ${suppliers.filter(s => s.active).map(s => `<option value="${s.id}" ${existing && existing.supplier_id === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
      </select>`)}
      ${fieldset('Order date', `<input class="input" type="date" name="order_date" value="${existing ? String(existing.order_date).slice(0,10) : new Date().toISOString().slice(0,10)}" />`)}
      ${fieldset('Expected date', `<input class="input" type="date" name="expected_date" value="${existing && existing.expected_date ? String(existing.expected_date).slice(0,10) : ''}" />`)}
      ${fieldset('Tax', `<input class="input" type="number" step="any" name="tax" value="${existing ? existing.tax : 0}" />`)}
    </div>
    ${fieldset('Notes', `<textarea class="input" rows="2" name="notes">${escapeHtml(existing ? existing.notes : '')}</textarea>`)}

    <div class="mt-3">
      <div class="flex justify-between items-center mb-2">
        <h4 class="font-medium text-sm">Lines</h4>
        <button class="btn btn-secondary text-xs" id="add-line">+ Add line</button>
      </div>
      <table class="border border-slate-200 rounded">
        <thead><tr><th>Item</th><th class="text-right">Qty</th><th class="text-right">Unit cost</th><th class="text-right">Line total</th><th></th></tr></thead>
        <tbody id="po-lines">
          ${lines.length === 0 ? '' : lines.map(lineRowHtml).join('')}
        </tbody>
      </table>
      <div class="text-right mt-3 text-sm">
        Subtotal: <span id="po-subtotal" class="font-semibold">${fmtMoney(0)}</span>
        &nbsp;+ Tax: <span id="po-tax-disp">${fmtMoney(existing ? existing.tax : 0)}</span>
        &nbsp;= Total: <span id="po-total" class="font-bold">${fmtMoney(0)}</span>
      </div>
    </div>

    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>${existing ? 'Save changes' : 'Create draft'}</button>
    </div>`;

  await modal(html, {
    title: existing ? 'Edit PO ' + existing.po_number : 'New purchase order',
    wide: true,
    onMount: (m, close) => {
      const tbody = m.querySelector('#po-lines');
      let counter = lines.length;
      const recalc = () => {
        let sub = 0;
        tbody.querySelectorAll('tr').forEach(tr => {
          const q = Number(tr.querySelector('[data-field="qty_ordered"]').value) || 0;
          const c = Number(tr.querySelector('[data-field="unit_cost"]').value) || 0;
          tr.querySelector('.line-total').textContent = fmtMoney(q * c);
          sub += q * c;
        });
        const tax = Number(m.querySelector('[name="tax"]').value) || 0;
        m.querySelector('#po-subtotal').textContent = fmtMoney(sub);
        m.querySelector('#po-tax-disp').textContent = fmtMoney(tax);
        m.querySelector('#po-total').textContent = fmtMoney(sub + tax);
      };
      const addLine = (data) => {
        const idx = counter++;
        // Use a tbody wrapper so the browser parses <tr>...</tr> correctly.
        // (Setting tr.innerHTML = '<tr>...</tr>' strips the inner tags and only the first
        //  <td> ends up as a child — which is why the row showed item dropdown but no qty/cost/total.)
        const wrap = document.createElement('tbody');
        wrap.innerHTML = lineRowHtml(data || { item_id: items[0] && items[0].id, qty_ordered: 1, unit_cost: 0 }, idx);
        const tr = wrap.firstElementChild;
        tbody.appendChild(tr);
        bindRow(tr);
        recalc();
      };
      // Auto-fill unit_cost from the supplier's price for this item, if one exists.
      // Only overwrites when the field is empty/zero — never clobbers a user's manual entry.
      const autoFillCost = (tr) => {
        const itemId = tr.querySelector('[data-field="item_id"]').value;
        const supId = m.querySelector('[name="supplier_id"]').value;
        const costInput = tr.querySelector('[data-field="unit_cost"]');
        if (Number(costInput.value) > 0) return;  // respect manual entry
        const c = supplierPriceFor(itemId, supId);
        if (c != null) costInput.value = c.toFixed(4);
      };
      const bindRow = (tr) => {
        tr.querySelectorAll('input, select').forEach(el => el.oninput = recalc);
        // Item change → try to auto-fill from supplier price
        tr.querySelector('[data-field="item_id"]').addEventListener('change', () => { autoFillCost(tr); recalc(); });
        tr.querySelector('[data-rm]').onclick = () => { tr.remove(); recalc(); };
      };
      tbody.querySelectorAll('tr').forEach(bindRow);
      // Supplier change → try to auto-fill cost for every line that's still empty
      m.querySelector('[name="supplier_id"]').addEventListener('change', () => {
        tbody.querySelectorAll('tr').forEach(autoFillCost);
        recalc();
      });
      m.querySelector('[name="tax"]').oninput = recalc;
      m.querySelector('#add-line').onclick = () => addLine();
      if (!lines.length) addLine();
      // For newly-created rows on first open, try to auto-fill if supplier already chosen
      tbody.querySelectorAll('tr').forEach(autoFillCost);
      recalc();

      m.querySelector('[data-cancel]').onclick = () => close(null);
      m.querySelector('[data-save]').onclick = async () => {
        const payload = {
          id: existing ? existing.id : undefined,
          supplier_id: m.querySelector('[name="supplier_id"]').value,
          order_date: m.querySelector('[name="order_date"]').value,
          expected_date: m.querySelector('[name="expected_date"]').value,
          notes: m.querySelector('[name="notes"]').value,
          tax: Number(m.querySelector('[name="tax"]').value) || 0,
          lines: Array.from(tbody.querySelectorAll('tr')).map(tr => ({
            item_id: tr.querySelector('[data-field="item_id"]').value,
            qty_ordered: Number(tr.querySelector('[data-field="qty_ordered"]').value),
            unit_cost: Number(tr.querySelector('[data-field="unit_cost"]').value)
          }))
        };
        try {
          if (existing) await api('po.update', payload);
          else await api('po.create', payload);
          toast('Saved', 'success');
          close(true);
          bootRefresh();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

async function openPOModal(id) {
  const po = await api('po.get', { id });
  const isDraft = po.status === 'draft';
  const isReceivable = po.status === 'sent' || po.status === 'partial';
  const html = `
    <div class="flex justify-between items-start mb-3">
      <div>
        <div class="text-xs text-slate-500">${fmtDay(po.order_date)}</div>
        <div class="font-semibold text-lg">PO ${escapeHtml(po.po_number)}</div>
      </div>
      <div>${statusBadge(po.status)}</div>
    </div>
    ${po.notes ? `<p class="text-sm text-slate-600 mb-3">${escapeHtml(po.notes)}</p>` : ''}
    <table class="border border-slate-200 rounded mb-3">
      <thead><tr><th>Item</th><th class="text-right">Ordered</th><th class="text-right">Received</th><th class="text-right">Unit cost</th><th class="text-right">Line total</th></tr></thead>
      <tbody>
        ${po.lines.map(l => `
          <tr>
            <td>${escapeHtml(l.item_name)} <span class="text-xs text-slate-400">(${escapeHtml(l.unit)})</span></td>
            <td class="text-right">${fmtNum(l.qty_ordered)}</td>
            <td class="text-right">${fmtNum(l.qty_received)}</td>
            <td class="text-right">${fmtMoney(l.unit_cost)}</td>
            <td class="text-right">${fmtMoney(l.line_total)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="text-right text-sm mb-4">
      Subtotal: <b>${fmtMoney(po.subtotal)}</b>  +  Tax: <b>${fmtMoney(po.tax)}</b>  =  <b class="text-lg">${fmtMoney(po.total)}</b>
    </div>
    <div class="flex justify-end gap-2">
      ${isDraft && can('manager') ? `<button class="btn btn-secondary" data-edit>Edit</button>` : ''}
      ${isDraft && can('manager') ? `<button class="btn btn-primary" data-send>Mark Sent</button>` : ''}
      ${isReceivable && can('receiver') ? `<button class="btn btn-primary" data-receive>Receive</button>` : ''}
      ${(isDraft || po.status === 'sent') && can('manager') ? `<button class="btn btn-danger" data-cancel-po>Cancel PO</button>` : ''}
      <button class="btn btn-ghost" data-cancel>Close</button>
    </div>`;
  await modal(html, {
    title: 'Purchase order',
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = () => close(null);
      const editBtn = m.querySelector('[data-edit]');
      if (editBtn) editBtn.onclick = async () => { close(null); await openPOEditor(po.id); };
      const sendBtn = m.querySelector('[data-send]');
      if (sendBtn) sendBtn.onclick = async () => {
        try { await api('po.send', { id: po.id }); toast('PO marked sent', 'success'); close(true); bootRefresh(); }
        catch (e) { toast(e.message, 'error'); }
      };
      const rcvBtn = m.querySelector('[data-receive]');
      if (rcvBtn) rcvBtn.onclick = async () => { close(null); await openReceiveModal(po.id); };
      const cancelBtn = m.querySelector('[data-cancel-po]');
      if (cancelBtn) cancelBtn.onclick = async () => {
        if (!(await confirmDialog('Cancel this PO?'))) return;
        try { await api('po.cancel', { id: po.id }); toast('Cancelled', 'success'); close(true); bootRefresh(); }
        catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

// ---------- Receiving ----------

function viewReceiving(root) {
  const pos = state.boot.pos.filter(p => p.status === 'sent' || p.status === 'partial');
  root.innerHTML = `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div class="px-5 py-3 border-b border-slate-200">
        <h3 class="font-semibold">Open POs ready for receiving</h3>
        <p class="text-xs text-slate-500">Only POs in <i>sent</i> or <i>partial</i> status appear here.</p>
      </div>
      <table>
        <thead><tr><th>PO #</th><th>Supplier</th><th>Status</th><th>Expected</th><th class="text-right">Total</th><th></th></tr></thead>
        <tbody>
          ${pos.length === 0
            ? '<tr><td colspan="6" class="text-center text-slate-400 py-6">Nothing to receive</td></tr>'
            : pos.map(p => `
              <tr>
                <td class="font-medium">${escapeHtml(p.po_number)}</td>
                <td>${escapeHtml(p.supplier_name)}</td>
                <td>${statusBadge(p.status)}</td>
                <td>${fmtDay(p.expected_date)}</td>
                <td class="text-right">${fmtMoney(p.total)}</td>
                <td class="text-right"><button class="btn btn-primary text-xs" data-receive="${p.id}">Receive →</button></td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  root.querySelectorAll('[data-receive]').forEach(b => b.onclick = () => openReceiveModal(b.dataset.receive));
}

async function openReceiveModal(poId) {
  const preview = await api('receive.preview', { po_id: poId });
  const locs = (state.boot.locations || []).filter(l => l.active);
  const html = `
    <p class="text-sm text-slate-600 mb-2">PO <b>${escapeHtml(preview.po_number)}</b> — enter the quantity received now per line. Leave 0 to skip.</p>
    ${fieldset('Destination location (applies to all lines)', `<select class="input max-w-xs" name="po_location_id">
      ${locs.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}
    </select>`)}
    <table class="border border-slate-200 rounded">
      <thead><tr><th>Item</th><th class="text-right">Outstanding</th><th class="text-right">Receive now</th><th class="text-right">Unit cost</th></tr></thead>
      <tbody>
        ${preview.lines.map(l => `
          <tr data-line="${l.line_id}">
            <td>${escapeHtml(l.item_name)} <span class="text-xs text-slate-400">(${escapeHtml(l.unit)})</span></td>
            <td class="text-right">${fmtNum(l.qty_outstanding)}</td>
            <td class="text-right"><input class="input text-right" type="number" step="any" min="0" max="${l.qty_outstanding}" data-qty value="${l.qty_outstanding}" /></td>
            <td class="text-right"><input class="input text-right" type="number" step="any" data-cost value="${l.unit_cost}" /></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-post>Post receipt</button>
    </div>`;
  await modal(html, {
    title: 'Receive goods',
    wide: true,
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = () => close(null);
      m.querySelector('[data-post]').onclick = async () => {
        const lines = Array.from(m.querySelectorAll('tr[data-line]')).map(tr => ({
          line_id: tr.dataset.line,
          qty_received_now: Number(tr.querySelector('[data-qty]').value),
          unit_cost: Number(tr.querySelector('[data-cost]').value)
        })).filter(l => l.qty_received_now > 0);
        if (!lines.length) { toast('Nothing to receive', 'error'); return; }
        try {
          const res = await api('receive.post', {
            po_id: poId,
            location_id: m.querySelector('[name="po_location_id"]').value,
            lines
          });
          toast(`Posted ${res.txn_count} receipt(s) — PO now ${res.status}`, 'success');
          close(true);
          bootRefresh();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

// ---------- Ledger ----------

function viewLedger(root) {
  const items = state.boot.items;
  const initialTxns = state.boot.ledger;  // first 100 from bootstrap, rendered instantly
  root.innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <select id="ledger-item" class="input max-w-sm">
        <option value="">All items</option>
        ${items.map(i => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('')}
      </select>
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table>
        <thead><tr><th>When</th><th>Item</th><th>Type</th><th class="text-right">Qty</th><th class="text-right">Unit cost</th><th class="text-right">Value</th><th>Ref</th><th>By</th></tr></thead>
        <tbody id="ledger-tbody"></tbody>
      </table>
    </div>`;
  const renderRows = (rows) => {
    document.getElementById('ledger-tbody').innerHTML = rows.length === 0
      ? '<tr><td colspan="8" class="text-center text-slate-400 py-6">No transactions</td></tr>'
      : rows.map(t => `
        <tr>
          <td class="text-slate-500">${fmtDate(t.txn_date)}</td>
          <td>${escapeHtml(t.item_name)}</td>
          <td><span class="badge bg-slate-100 text-slate-700">${t.type}</span></td>
          <td class="text-right ${t.qty < 0 ? 'text-rose-600' : 'text-emerald-700'}">${fmtNum(t.qty)}</td>
          <td class="text-right">${fmtMoney(t.unit_cost)}</td>
          <td class="text-right">${fmtMoney(t.total_cost)}</td>
          <td class="text-slate-500 text-xs">${escapeHtml(t.ref_type)} ${escapeHtml(t.ref_id ? t.ref_id.slice(0,8) : '')}</td>
          <td class="text-slate-500 text-xs">${escapeHtml(t.created_by)}</td>
        </tr>`).join('');
  };
  // Render the bootstrap-cached 100 immediately.
  renderRows(initialTxns);
  // Filter / "load more" via API.
  document.getElementById('ledger-item').onchange = async () => {
    const itemId = document.getElementById('ledger-item').value || undefined;
    try {
      const rows = await api('inv.ledger', { limit: 500, item_id: itemId });
      renderRows(rows);
    } catch (e) { toast(e.message, 'error'); }
  };
}

// ---------- Stock Counts ----------

function viewCounts(root) {
  const list = state.boot.counts;
  root.innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <p class="text-sm text-slate-500">Stock counts post the variance vs. system as a "count" inventory transaction.</p>
      ${can('manager') ? '<button class="btn btn-primary" id="new-count">+ New count</button>' : ''}
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table>
        <thead><tr><th>Date</th><th>Status</th><th>Notes</th><th>Started by</th><th>Completed</th><th></th></tr></thead>
        <tbody>
          ${list.length === 0
            ? '<tr><td colspan="6" class="text-center text-slate-400 py-6">No counts yet</td></tr>'
            : list.map(c => `
              <tr>
                <td>${fmtDay(c.count_date)}</td>
                <td>${statusBadge(c.status)}</td>
                <td class="text-slate-500">${escapeHtml(c.notes)}</td>
                <td class="text-slate-500">${escapeHtml(c.created_by)}</td>
                <td class="text-slate-500">${c.completed_at ? fmtDate(c.completed_at) : ''}</td>
                <td class="text-right"><button class="btn btn-ghost text-xs" data-open="${c.id}">Open</button></td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  if (can('manager')) document.getElementById('new-count').onclick = async () => {
    const locs = (state.boot.locations || []).filter(l => l.active);
    if (!locs.length) { toast('Create a location first', 'error'); return; }
    // Quick picker for which location to count
    const picked = await modal(`
      <p class="text-sm text-slate-600 mb-2">Pick a location to count. Lines will be seeded from current system qty at that location.</p>
      ${fieldset('Location', `<select class="input" name="loc">${locs.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}</select>`)}
      <div class="flex justify-end gap-2 mt-4">
        <button class="btn btn-secondary" data-cancel>Cancel</button>
        <button class="btn btn-primary" data-ok>Start count</button>
      </div>
    `, {
      title: 'New stock count',
      onMount: (m, close) => {
        m.querySelector('[data-cancel]').onclick = () => close(null);
        m.querySelector('[data-ok]').onclick = () => close(m.querySelector('[name="loc"]').value);
      }
    });
    if (!picked) return;
    try { const r = await api('count.create', { location_id: picked }); toast('Count started', 'success'); openCountModal(r.id); bootRefresh(); }
    catch (e) { toast(e.message, 'error'); }
  };
  root.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openCountModal(b.dataset.open));
}

async function openCountModal(id) {
  const c = await api('count.get', { id });
  const editable = c.status === 'in_progress';
  const totalVar = c.lines.reduce((s, l) => s + (l.variance_value || 0), 0);
  const html = `
    <div class="flex justify-between mb-3">
      <div>
        <div class="text-xs text-slate-500">${fmtDay(c.count_date)}</div>
        <div class="font-semibold">Stock count</div>
      </div>
      <div class="text-right">
        ${statusBadge(c.status)}
        <div class="text-xs text-slate-500 mt-1">Variance value: <b class="${totalVar < 0 ? 'text-rose-600' : 'text-emerald-700'}">${fmtMoney(totalVar)}</b></div>
      </div>
    </div>
    <div class="max-h-96 overflow-y-auto border border-slate-200 rounded">
      <table>
        <thead class="sticky top-0"><tr><th>Item</th><th class="text-right">System</th><th class="text-right">Counted</th><th class="text-right">Variance</th><th class="text-right">Value</th></tr></thead>
        <tbody>
          ${c.lines.map(l => `
            <tr data-line="${l.id}">
              <td>${escapeHtml(l.item_name)} <span class="text-xs text-slate-400">(${escapeHtml(l.unit)})</span></td>
              <td class="text-right text-slate-500">${fmtNum(l.system_qty)}</td>
              <td class="text-right">
                ${editable
                  ? `<input class="input text-right" type="number" step="any" data-counted value="${l.counted_qty === null ? '' : l.counted_qty}" />`
                  : (l.counted_qty === null ? '<span class="text-slate-300">—</span>' : fmtNum(l.counted_qty))}
              </td>
              <td class="text-right variance ${(l.variance || 0) < 0 ? 'text-rose-600' : 'text-emerald-700'}">${l.variance === null ? '' : fmtNum(l.variance)}</td>
              <td class="text-right variance-value">${l.variance_value === null ? '' : fmtMoney(l.variance_value)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="flex justify-end gap-2 mt-4">
      ${editable && can('manager') ? '<button class="btn btn-danger" data-cancel-count>Cancel count</button>' : ''}
      ${editable && can('manager') ? '<button class="btn btn-primary" data-complete>Complete & post variance</button>' : ''}
      <button class="btn btn-secondary" data-close>Close</button>
    </div>`;
  await modal(html, {
    title: 'Stock count detail',
    wide: true,
    onMount: (m, close) => {
      m.querySelector('[data-close]').onclick = () => close(null);
      if (editable) {
        m.querySelectorAll('input[data-counted]').forEach(inp => {
          inp.onchange = async () => {
            const tr = inp.closest('tr');
            try {
              const r = await api('count.saveLine', {
                line_id: tr.dataset.line,
                counted_qty: inp.value === '' ? null : Number(inp.value)
              });
              tr.querySelector('.variance').textContent = r.variance === '' ? '' : fmtNum(r.variance);
              tr.querySelector('.variance-value').textContent = r.variance_value === '' ? '' : fmtMoney(r.variance_value);
            } catch (e) { toast(e.message, 'error'); }
          };
        });
        const compBtn = m.querySelector('[data-complete]');
        if (compBtn) compBtn.onclick = async () => {
          if (!(await confirmDialog('Complete this count and post all variances as inventory transactions?'))) return;
          try {
            const r = await api('count.complete', { id });
            toast(`Completed — posted ${r.txn_count} variance txn(s)`, 'success');
            close(true);
            bootRefresh();
          } catch (e) { toast(e.message, 'error'); }
        };
        const cancBtn = m.querySelector('[data-cancel-count]');
        if (cancBtn) cancBtn.onclick = async () => {
          if (!(await confirmDialog('Cancel this count? Lines will be discarded.'))) return;
          try { await api('count.cancel', { id }); toast('Cancelled', 'success'); close(true); bootRefresh(); }
          catch (e) { toast(e.message, 'error'); }
        };
      }
    }
  });
}

// ---------- Users (admin) ----------

function viewUsers(root) {
  const rows = state.boot.users || [];
  root.innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <p class="text-sm text-slate-500">Users are matched by email. They must sign in with the same Google account.</p>
      <button class="btn btn-primary" id="new-user">+ Add user</button>
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table>
        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Active</th><th></th></tr></thead>
        <tbody>
          ${rows.map(u => `
            <tr>
              <td class="font-medium">${escapeHtml(u.email)}</td>
              <td>${escapeHtml(u.name)}</td>
              <td><span class="badge bg-brand-100 text-brand-700">${u.role}</span></td>
              <td>${u.active ? '<span class="badge bg-emerald-100 text-emerald-700">yes</span>' : '<span class="badge bg-slate-100 text-slate-500">no</span>'}</td>
              <td class="text-right">
                <button class="btn btn-ghost text-xs" data-edit='${escapeHtml(JSON.stringify(u))}'>Edit</button>
                ${u.email === state.me.email ? '' : `<button class="btn btn-ghost text-xs text-rose-600" data-del="${u.id}">Del</button>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  document.getElementById('new-user').onclick = () => openUserModal();
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openUserModal(JSON.parse(b.dataset.edit)));
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteUser(b.dataset.del));
}

async function openUserModal(existing) {
  const e = existing || {};
  const html = `
    ${fieldset('Email *', `<input class="input" type="email" name="email" value="${escapeHtml(e.email || '')}" ${existing ? 'readonly' : ''} required />`)}
    ${fieldset('Name', `<input class="input" name="name" value="${escapeHtml(e.name || '')}" />`)}
    ${fieldset('Role *', `<select class="input" name="role" required>
      ${['admin','manager','receiver','viewer'].map(r => `<option value="${r}" ${e.role === r ? 'selected' : ''}>${r}</option>`).join('')}
    </select>`)}
    <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" name="active" ${existing === undefined || e.active ? 'checked' : ''} /> Active</label>
    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>Save</button>
    </div>`;
  await modal(html, {
    title: existing ? 'Edit user' : 'Add user',
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = () => close(null);
      m.querySelector('[data-save]').onclick = async () => {
        const get = (n) => m.querySelector(`[name="${n}"]`).value;
        try {
          await api('users.upsert', {
            id: existing ? existing.id : undefined,
            email: get('email'), name: get('name'), role: get('role'),
            active: m.querySelector('[name="active"]').checked
          });
          toast('Saved', 'success');
          close(true);
          bootRefresh();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

async function deleteUser(id) {
  if (!(await confirmDialog('Remove this user? They will lose access.'))) return;
  try { await api('users.delete', { id }); toast('Removed', 'success'); bootRefresh(); }
  catch (e) { toast(e.message, 'error'); }
}

// ---------- Locations ----------

function viewLocations(root) {
  const rows = state.boot.locations || [];
  root.innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <p class="text-sm text-slate-500">Storage zones inside this restaurant. Each receive / adjust / count picks a location.</p>
      ${can('manager') ? '<button class="btn btn-primary" id="new-loc">+ New location</button>' : ''}
    </div>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Notes</th><th>Active</th><th></th></tr></thead>
        <tbody>
          ${rows.length === 0
            ? '<tr><td colspan="5" class="text-center text-slate-400 py-6">No locations yet</td></tr>'
            : rows.map(r => `
              <tr>
                <td class="font-medium">${escapeHtml(r.name)}</td>
                <td class="text-slate-500">${escapeHtml(r.type)}</td>
                <td class="text-slate-500">${escapeHtml(r.notes)}</td>
                <td>${r.active ? '<span class="badge bg-emerald-100 text-emerald-700">yes</span>' : '<span class="badge bg-slate-100 text-slate-500">no</span>'}</td>
                <td class="text-right">
                  ${can('manager') ? `<button class="btn btn-ghost text-xs" data-edit='${escapeHtml(JSON.stringify(r))}'>Edit</button>` : ''}
                  ${can('manager') ? `<button class="btn btn-ghost text-xs text-rose-600" data-del="${r.id}">Del</button>` : ''}
                </td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  if (can('manager')) document.getElementById('new-loc').onclick = () => openLocationModal();
  root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openLocationModal(JSON.parse(b.dataset.edit)));
  root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteLocation(b.dataset.del));
}

async function openLocationModal(existing) {
  const e = existing || {};
  const html = `
    ${fieldset('Name *', `<input class="input" name="name" value="${escapeHtml(e.name || '')}" required />`)}
    ${fieldset('Type', `<select class="input" name="type">
      ${['storage','prep','service','other'].map(t => `<option value="${t}" ${e.type === t ? 'selected' : ''}>${t}</option>`).join('')}
    </select>`)}
    ${fieldset('Notes', `<textarea class="input" rows="2" name="notes">${escapeHtml(e.notes || '')}</textarea>`)}
    <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" name="active" ${e.id === undefined || e.active ? 'checked' : ''} /> Active</label>
    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-secondary" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-save>Save</button>
    </div>`;
  await modal(html, {
    title: existing ? 'Edit location' : 'New location',
    onMount: (m, close) => {
      m.querySelector('[data-cancel]').onclick = () => close(null);
      m.querySelector('[data-save]').onclick = async () => {
        const get = (n) => m.querySelector(`[name="${n}"]`).value;
        try {
          await api('locations.upsert', {
            id: existing ? existing.id : undefined,
            name: get('name'), type: get('type'), notes: get('notes'),
            active: m.querySelector('[name="active"]').checked
          });
          toast('Saved', 'success');
          close(true);
          bootRefresh();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}

async function deleteLocation(id) {
  if (!(await confirmDialog('Delete this location? Blocked if any stock still sits here.'))) return;
  try { await api('locations.delete', { id }); toast('Deleted', 'success'); bootRefresh(); }
  catch (e) { toast(e.message, 'error'); }
}

// ---------- Import ----------

function viewImport(root) {
  const masterSample = 'ITEM,PACK,PACK COST,BASE UNIT,UNIT QTY,COST PER G/ML/PC,BRAND,SUPPLIER,TYPE,NOTES\nALL PURPOSE FLOUR JOP,1 KG,57.00,G,1000,₱0.06,,JOPHIL,RAW ING,\nBACARDI BLACK RUM,1 BTL,"1,000.00",ML,750,₱1.33,Bacardi,BARNA,RAW ING,';
  root.innerHTML = `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-5 mb-4">
      <h3 class="font-semibold mb-2">Bulk import from FF Master List</h3>
      <p class="text-sm text-slate-600 mb-2">
        Paste your master list CSV below (with a header row). The importer recognizes your existing columns:
        <code class="text-xs">ITEM, PACK, PACK COST, BASE UNIT, UNIT QTY, COST PER G/ML/PC, BRAND, SUPPLIER, TYPE, NOTES</code>.
      </p>
      <ul class="text-xs text-slate-600 mb-2 list-disc pl-5 space-y-1">
        <li>Rows are <b>grouped by ITEM name</b> (case + whitespace insensitive). All "ALL PURPOSE FLOUR" rows become ONE item with multiple supplier prices.</li>
        <li>Suppliers not yet in the system are <b>auto-created</b></li>
        <li>SKUs are <b>auto-generated</b> per category (RAW-0001, SUP-0001, SUB-0001…)</li>
        <li>If rows for the same name have different category/unit/brand, the <b>first row wins</b> and the conflict is flagged</li>
        <li>₱ symbols and comma thousands separators are stripped automatically</li>
        <li>No opening stock posted — this is a catalog. Use stock counts later to set opening balances.</li>
      </ul>
      <details class="text-xs text-slate-500 mb-3"><summary class="cursor-pointer">Show sample (your format)</summary><pre class="bg-slate-50 p-3 rounded overflow-x-auto mt-2">${escapeHtml(masterSample)}</pre></details>
      <textarea id="csv-text" class="input font-mono text-xs" rows="10" placeholder="Paste your master list CSV here…"></textarea>
      <div class="flex gap-2 mt-3 justify-end">
        <button class="btn btn-secondary" id="csv-preview">Preview (dry run)</button>
        <button class="btn btn-primary" id="csv-import" disabled>Import</button>
      </div>
    </div>
    <div id="csv-report"></div>`;
  let parsed = null;
  document.getElementById('csv-preview').onclick = async () => {
    const text = document.getElementById('csv-text').value.trim();
    if (!text) { toast('Paste a CSV first', 'error'); return; }
    try {
      parsed = parseCsv(text);
      if (!parsed.rows.length) throw new Error('No data rows found.');
      // Dry-run on server
      const report = await api('import.items', { rows: parsed.rows, dry_run: true });
      renderCsvReport(parsed, report, true);
      document.getElementById('csv-import').disabled = false;
    } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('csv-import').onclick = async () => {
    if (!parsed) return;
    if (!(await confirmDialog(`Import ${parsed.rows.length} rows? This will create/update items and post opening-stock transactions.`))) return;
    try {
      const report = await api('import.items', { rows: parsed.rows, dry_run: false });
      renderCsvReport(parsed, report, false);
      toast(`Imported: ${report.created} new, ${report.updated} updated, ${report.suppliers_created || 0} suppliers auto-created`, 'success');
      bootRefresh();
    } catch (e) { toast(e.message, 'error'); }
  };
}

function renderCsvReport(parsed, report, isDryRun) {
  const el = document.getElementById('csv-report');
  const verb = isDryRun ? 'Will' : 'Did';
  el.innerHTML = `
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
      <h3 class="font-semibold mb-3">${isDryRun ? 'Preview' : 'Result'} — ${parsed.rows.length} rows</h3>
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
        <div class="border border-slate-200 rounded p-3"><div class="text-xs text-slate-500">${verb} create items</div><div class="font-bold">${report.created}</div></div>
        <div class="border border-slate-200 rounded p-3"><div class="text-xs text-slate-500">${verb} update items</div><div class="font-bold">${report.updated}</div></div>
        <div class="border border-slate-200 rounded p-3"><div class="text-xs text-slate-500">Supplier prices</div><div class="font-bold">${report.prices_added || 0}</div></div>
        <div class="border border-slate-200 rounded p-3"><div class="text-xs text-slate-500">${verb} auto-create suppliers</div><div class="font-bold">${report.suppliers_created || 0}</div></div>
        <div class="border border-slate-200 rounded p-3 ${report.errors.length ? 'border-rose-300 bg-rose-50' : ''}"><div class="text-xs text-slate-500">Errors / notices</div><div class="font-bold ${report.errors.length ? 'text-rose-600' : ''}">${report.errors.length}</div></div>
      </div>
      ${report.errors.length ? `
        <h4 class="font-medium text-sm mb-2 text-rose-600">Row issues</h4>
        <div class="max-h-64 overflow-y-auto border border-slate-200 rounded mb-4">
          <table>
            <thead class="sticky top-0"><tr><th>CSV row</th><th>Name</th><th>Issue</th></tr></thead>
            <tbody>
              ${report.errors.map(e => `<tr>
                <td>${e.row}</td><td class="text-slate-500">${escapeHtml(e.name || e.sku || '')}</td><td class="text-rose-700">${escapeHtml(e.message)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="text-sm text-emerald-700">No issues.</p>'}
    </div>`;
}

/**
 * Minimal CSV parser that handles quoted fields and embedded commas/newlines.
 * Returns { headers: [...], rows: [{header: value}, ...] }
 */
function parseCsv(text) {
  // RFC-4180-ish: support double-quote escaping ("" → ")
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cur.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        cur.push(field); rows.push(cur); cur = []; field = '';
      } else field += ch;
    }
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows.shift().map(h => h.trim());
  const objects = rows
    .filter(r => r.some(c => String(c).trim() !== ''))  // skip blank lines
    .map(r => {
      const o = {};
      headers.forEach((h, i) => { o[h] = (r[i] !== undefined ? r[i] : '').trim(); });
      return o;
    });
  return { headers, rows: objects };
}

// ---------- Boot ----------

document.addEventListener('DOMContentLoaded', boot);

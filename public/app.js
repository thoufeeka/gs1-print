/* ============================================================
   GS1 Pallet Label Printer — Application Logic (app.js)
   ============================================================
   Sections:
   1.  Application State
   2.  GS1 / SSCC Core Engine
   3.  Settings & Config
   4.  Barcode Rendering
   5.  API Layer (fetch-order)
   6.  Order Lines Table
   7.  Pallet Manager
   8.  Label Customizer & Preview Sync
   9.  Print Protocol
   10. Utility Helpers / Toast
   ============================================================ */

'use strict';

// ═══════════════════════════════════════════════════════════════
// §0  AUTHENTICATION (Simple .env credentials)
// ═══════════════════════════════════════════════════════════════

function getAuthHeaders() {
  const token = sessionStorage.getItem('gs1_auth_token') || '';
  return {
    'Content-Type': 'application/json',
    'x-auth-token': token,
  };
}

function showLoginModal(show = true) {
  const overlay = document.getElementById('login-overlay');
  const userPill = document.getElementById('user-pill');
  if (!overlay) return;

  if (show) {
    overlay.classList.remove('hidden');
    if (userPill) {
      userPill.classList.add('hidden');
      userPill.classList.remove('flex');
    }
    setTimeout(() => document.getElementById('login-username')?.focus(), 100);
  } else {
    overlay.classList.add('hidden');
    if (userPill) {
      userPill.classList.remove('hidden');
      userPill.classList.add('flex');
    }
  }
}

async function checkAuthStatus() {
  const token = sessionStorage.getItem('gs1_auth_token');
  if (!token) {
    showLoginModal(true);
    return false;
  }

  try {
    const res = await fetch('/api/auth-check', {
      headers: getAuthHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      setText('user-display-name', data.username || 'admin');
      showLoginModal(false);
      return true;
    } else {
      sessionStorage.removeItem('gs1_auth_token');
      showLoginModal(true);
      return false;
    }
  } catch (e) {
    showLoginModal(true);
    return false;
  }
}

async function submitLogin() {
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-submit-btn');

  const username = usernameInput?.value?.trim() || '';
  const password = passwordInput?.value?.trim() || '';

  if (!username || !password) {
    if (errorEl) {
      errorEl.textContent = 'Please enter both username and password.';
      errorEl.classList.remove('hidden');
    }
    return;
  }

  if (errorEl) errorEl.classList.add('hidden');
  setButtonLoading(btn, true, 'Signing in…');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Invalid credentials.');
    }

    sessionStorage.setItem('gs1_auth_token', data.token);
    setText('user-display-name', data.username || username);
    showLoginModal(false);
    showToast(`Signed in as ${data.username || username}`, 'success');

    // Load configuration & test connection now that we are authenticated
    await loadConfig();

  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || 'Login failed.';
      errorEl.classList.remove('hidden');
    }
  } finally {
    setButtonLoading(btn, false, '', 'Sign In');
  }
}

async function logout() {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: getAuthHeaders(),
    });
  } catch (_) {}

  sessionStorage.removeItem('gs1_auth_token');
  showLoginModal(true);
  showToast('Logged out.', 'info');
}

// ═══════════════════════════════════════════════════════════════
// §1  APPLICATION STATE
// ═══════════════════════════════════════════════════════════════

const State = {
  // Server-side config (fetched on load)
  config: {
    odoo_url: '',
    odoo_db: '',
    gs1_company_prefix: '26249798',
    sscc_start_serial: 1000,
    extension_digit: '3',
    api_key_set: false,
  },

  // Loaded order data
  order: null,         // { order_id, pickings[], move_lines[] }
  moveLines: [],       // Enriched move line objects

  // Pallet system
  pallets: [],         // Array of Pallet objects
  activePalletIndex: -1,

  // SSCC serial counter (runtime)
  nextSerial: 1000,

  // Label customizer fields (mirrors DOM inputs)
  label: {
    palletTitle: '',
    category: '',
    orderNumber: '',
    sscc: '',
    items: [],          // [{ gtin, productName, qtyText, descOverride }]
    orderRef: '9202851073',  // the (400) barcode value
  },
};

// ═══════════════════════════════════════════════════════════════
// §2  GS1 / SSCC CORE ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Compute GS1 Mod-10 weighted check digit for a numeric string.
 * Weights alternate 3, 1, 3, 1 ... from left to right.
 * @param {string} digits17 — the 17-digit base string
 * @returns {number} check digit (0-9)
 */
function computeGS1CheckDigit(digits17) {
  if (digits17.length !== 17) {
    throw new Error(`SSCC base must be 17 digits, got ${digits17.length}: "${digits17}"`);
  }

  let sumOdd  = 0; // positions 1,3,5,... (1-indexed) → multiplied by 3
  let sumEven = 0; // positions 2,4,6,... (1-indexed) → multiplied by 1

  for (let i = 0; i < 17; i++) {
    const digit = parseInt(digits17[i], 10);
    if ((i + 1) % 2 === 1) {
      // odd position (1-indexed): weight 3
      sumOdd += digit;
    } else {
      // even position (1-indexed): weight 1
      sumEven += digit;
    }
  }

  const total = (sumOdd * 3) + sumEven;
  const checkDigit = (10 - (total % 10)) % 10;
  return checkDigit;
}

/**
 * Build a complete 18-digit SSCC.
 * Structure: [ExtDigit(1)] + [GS1CompanyPrefix(8)] + [Serial(8)] + [CheckDigit(1)]
 *
 * @param {string} extensionDigit  — typically '3'
 * @param {string} gs1Prefix       — e.g. '26249798' (8 digits)
 * @param {number} serialNumber    — auto-incremented integer
 * @returns {string} 18-digit SSCC
 */
function buildSSCC(extensionDigit, gs1Prefix, serialNumber) {
  // Determine how many serial digits we need:
  // 17 total base = 1 (ext) + len(prefix) + len(serial)
  const baseLen = 17;
  const prefixLen = gs1Prefix.length;
  const serialLen = baseLen - 1 - prefixLen;  // 17 - 1 - 8 = 8

  if (serialLen < 1) {
    throw new Error('GS1 Company Prefix is too long. Must leave at least 1 digit for serial.');
  }

  const serialStr = String(serialNumber).padStart(serialLen, '0');

  if (serialStr.length > serialLen) {
    throw new Error(`Serial number ${serialNumber} exceeds available ${serialLen} digits.`);
  }

  const base17 = `${extensionDigit}${gs1Prefix}${serialStr}`;
  const checkDigit = computeGS1CheckDigit(base17);
  const sscc = `${base17}${checkDigit}`;

  return sscc;
}

/**
 * Generate the next SSCC using current State config and increment the counter.
 * @returns {string}
 */
function nextSSCC() {
  const sscc = buildSSCC(
    State.config.extension_digit,
    State.config.gs1_company_prefix,
    State.nextSerial
  );
  State.nextSerial++;
  updateSettingsPreview();
  return sscc;
}

// ═══════════════════════════════════════════════════════════════
// §3  SETTINGS & CONFIG
// ═══════════════════════════════════════════════════════════════

async function loadConfig() {
  try {
    const res = await fetch('/api/config', { headers: getAuthHeaders() });
    if (res.status === 401) {
      showLoginModal(true);
      return;
    }
    if (!res.ok) throw new Error('Config fetch failed');
    const data = await res.json();

    State.config = { ...State.config, ...data };
    State.nextSerial = data.sscc_start_serial || 1000;

    // Populate settings tray
    setText('cfg-odoo-url', data.odoo_url);
    setText('cfg-odoo-db', data.odoo_db);

    const apiKeyEl = document.getElementById('cfg-api-key');
    if (data.api_key_set) {
      apiKeyEl.innerHTML = '<span class="badge badge-done">●&nbsp;Configured</span>';
    } else {
      apiKeyEl.innerHTML = '<span class="badge badge-draft">Not set</span>';
    }

    setText('cfg-gs1-prefix', data.gs1_company_prefix);
    setText('cfg-ext-digit', data.extension_digit || '3');
    setText('cfg-sscc-serial', data.sscc_start_serial);

    // Serial override input
    const overrideInput = document.getElementById('serial-override-input');
    if (overrideInput) overrideInput.value = data.sscc_start_serial;

    updateSettingsPreview();
    updateApiStatus(true, data.api_key_set, 'Connecting...');

    if (data.api_key_set) {
      fetch('/api/test-connection', { headers: getAuthHeaders() })
        .then(r => {
          if (r.status === 401) {
            showLoginModal(true);
            return null;
          }
          return r.json();
        })
        .then(conn => {
          if (!conn) return;
          if (conn.success) {
            updateApiStatus(true, true, 'Odoo 19 Ready');
          } else {
            updateApiStatus(true, false, 'Auth Error');
          }
        })
        .catch(() => updateApiStatus(false, false, 'Offline'));
    }

  } catch (err) {
    console.warn('[Config] Could not load config:', err.message);
    updateApiStatus(false, false, 'Offline');
  }
}

function updateSettingsPreview() {
  try {
    const preview = buildSSCC(
      State.config.extension_digit,
      State.config.gs1_company_prefix,
      State.nextSerial
    );
    setText('cfg-sscc-preview', preview);
  } catch {
    setText('cfg-sscc-preview', '(invalid config)');
  }
}

function updateSerialOverride(val) {
  const n = parseInt(val, 10);
  if (!isNaN(n) && n >= 0) {
    State.nextSerial = n;
    updateSettingsPreview();
  }
}

function toggleSettings() {
  const tray = document.getElementById('settings-tray');
  tray.classList.toggle('open');
}

function updateApiStatus(connected, apiKeySet, customText) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  if (connected && apiKeySet) {
    dot.className  = 'w-2 h-2 rounded-full bg-emerald-500';
    text.textContent = customText || 'Odoo 19 Ready';
    text.className = 'text-emerald-700 font-medium';
  } else if (connected && !apiKeySet) {
    dot.className  = 'w-2 h-2 rounded-full bg-amber-500';
    text.textContent = customText || 'No API Key';
    text.className = 'text-amber-700 font-medium';
  } else {
    dot.className  = 'w-2 h-2 rounded-full bg-rose-500';
    text.textContent = customText || 'Offline';
    text.className = 'text-rose-700 font-medium';
  }
}

// ═══════════════════════════════════════════════════════════════
// §4  BARCODE RENDERING
// ═══════════════════════════════════════════════════════════════

/**
 * Render a GS1-128 barcode into an SVG element using JsBarcode.
 * The visible text uses GS1 Application Identifier notation.
 *
 * @param {string} svgId      — DOM id of the <svg> element
 * @param {string} aiPrefix   — Application Identifier, e.g. "(400)" or "(00)"
 * @param {string} value      — The data value (without AI parentheses)
 */
function renderBarcode(svgId, aiPrefix, value) {
  const el = document.getElementById(svgId);
  if (!el) return;

  const displayText = `${aiPrefix}${value}`;

  try {
    JsBarcode(`#${svgId}`, value, {
      format: 'CODE128',
      width: 1.6,
      height: 40,
      displayValue: false,      // we render human-readable text separately
      margin: 2,
      background: '#ffffff',
      lineColor: '#000000',
    });
  } catch (err) {
    console.warn(`[Barcode] Render failed for ${svgId}:`, err.message);
    el.innerHTML = `<text x="10" y="20" font-size="10" fill="red">Error: ${err.message}</text>`;
  }
}

function renderAllBarcodes() {
  const orderRef  = State.label.orderRef || '9202851073';
  const sscc      = State.label.sscc || '';

  renderBarcode('barcode-order-ref', '(400)', orderRef);
  setText('barcode-order-ref-text', `(400)${orderRef}`);

  if (sscc && sscc.length === 18) {
    renderBarcode('barcode-sscc-tag', '(00)', sscc);
    setText('barcode-sscc-text', `(00)${sscc}`);
  } else {
    const el = document.getElementById('barcode-sscc-tag');
    if (el) el.innerHTML = '';
    setText('barcode-sscc-text', '(00) — awaiting SSCC');
  }
}

// ═══════════════════════════════════════════════════════════════
// §5  API LAYER
// ═══════════════════════════════════════════════════════════════

async function fetchOrder() {
  const input = document.getElementById('order-input');
  const orderId = input?.value?.trim();

  if (!orderId) {
    showToast('Please enter an Order ID.', 'error');
    return;
  }

  const btn = document.getElementById('fetch-btn');
  setButtonLoading(btn, true, 'Fetching…');

  try {
    const res = await fetch('/api/fetch-order', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ order_id: orderId }),
    });

    if (res.status === 401) {
      showLoginModal(true);
      throw new Error('Session expired or unauthorized. Please sign in.');
    }

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Server error ${res.status}`);
    }

    // Store order data
    State.order    = data;
    State.moveLines = data.move_lines || [];

    // Update config from response (SSCC parameters)
    if (data.config) {
      State.config.gs1_company_prefix = data.config.gs1_company_prefix;
      State.config.extension_digit    = data.config.extension_digit;
      if (State.nextSerial < data.config.sscc_start_serial) {
        State.nextSerial = data.config.sscc_start_serial;
      }
      updateSettingsPreview();
    }

    // Initialize workspace
    initWorkspace(data);
    showToast(`Loaded ${data.move_lines.length} line(s) for ${data.order_id}`, 'success');

  } catch (err) {
    console.error('[fetchOrder]', err);
    showToast(err.message, 'error');
  } finally {
    setButtonLoading(btn, false, '', `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path d="m21 21-4.35-4.35M11 19A8 8 0 1 0 11 3a8 8 0 0 0 0 16z"/>
      </svg>
      Fetch Details
    `);
  }
}

// ═══════════════════════════════════════════════════════════════
// §6  ORDER LINES TABLE
// ═══════════════════════════════════════════════════════════════

function initWorkspace(data) {
  // Show workspace, hide empty state
  document.getElementById('main-workspace').classList.remove('hidden');
  document.getElementById('empty-state').classList.add('hidden');

  // Populate order banner
  const picking = data.pickings?.[0] || {};
  setText('order-banner-id', data.order_id);
  setText('order-banner-picking', data.pickings.map(p => p.name).join(', ') || '—');

  const statusEl = document.getElementById('order-banner-status');
  const state = picking.state || 'draft';
  const badgeClass = state === 'done' ? 'badge-done' : state === 'assigned' ? 'badge-assigned' : 'badge-draft';
  statusEl.className = `badge ${badgeClass}`;
  statusEl.textContent = state.toUpperCase();

  // Render lines table
  renderOrderLinesTable();

  // Auto-create pallet 1
  State.pallets = [];
  State.activePalletIndex = -1;
  addNewPallet();
}

function renderOrderLinesTable() {
  const tbody = document.getElementById('order-lines-body');
  const countLabel = document.getElementById('lines-count-label');

  if (!State.moveLines.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-slate-500 py-8">No lines found</td></tr>';
    countLabel.textContent = '0 lines';
    return;
  }

  countLabel.textContent = `${State.moveLines.length} line${State.moveLines.length !== 1 ? 's' : ''}`;

  tbody.innerHTML = State.moveLines.map((line, idx) => {
    const palletQty = getPalletQtyForLine(idx);
    const maxQty = line.qty_done || line.qty_demand || 0;

    return `
      <tr>
        <td>
          <div class="font-medium text-slate-800 text-xs leading-tight">${escapeHtml(line.product_name)}</div>
          ${line.product_ref ? `<div class="text-slate-500 text-xs">[${escapeHtml(line.product_ref)}]</div>` : ''}
        </td>
        <td class="barcode-cell">${line.barcode ? escapeHtml(line.barcode) : '<span class="text-slate-400 italic">—</span>'}</td>
        <td class="qty-cell">${maxQty}</td>
        <td>
          <input type="number"
                 class="split-input"
                 id="split-input-${idx}"
                 min="0" max="${maxQty}"
                 value="${palletQty}"
                 onchange="onSplitChange(${idx}, this.value)"
                 title="Qty for active pallet" />
        </td>
        <td class="text-right">
          <button class="btn-secondary text-xs py-1 px-2" onclick="setFullQty(${idx})">
            All
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function getPalletQtyForLine(lineIdx) {
  if (State.activePalletIndex < 0) return 0;
  const pallet = State.pallets[State.activePalletIndex];
  return pallet?.lines?.[lineIdx]?.qty ?? 0;
}

function onSplitChange(lineIdx, value) {
  if (State.activePalletIndex < 0) {
    showToast('No active pallet selected. Click a pallet tab first.', 'error');
    return;
  }
  const pallet = State.pallets[State.activePalletIndex];
  const line   = State.moveLines[lineIdx];
  const maxQty = line.qty_done || line.qty_demand || 0;
  const qty    = Math.min(parseInt(value, 10) || 0, maxQty);

  if (!pallet.lines[lineIdx]) {
    pallet.lines[lineIdx] = { lineIdx, qty: 0 };
  }
  pallet.lines[lineIdx].qty = qty;

  refreshPalletSummary();
  autoUpdateCustomizerFromPallet();
}

function setFullQty(lineIdx) {
  const line   = State.moveLines[lineIdx];
  const maxQty = line.qty_done || line.qty_demand || 0;
  const input  = document.getElementById(`split-input-${lineIdx}`);
  if (input) {
    input.value = maxQty;
    onSplitChange(lineIdx, maxQty);
  }
}

// ═══════════════════════════════════════════════════════════════
// §7  PALLET MANAGER
// ═══════════════════════════════════════════════════════════════

/**
 * Pallet object shape:
 * {
 *   id: number,
 *   label: string,
 *   sscc: string,
 *   lines: { [lineIdx]: { lineIdx, qty } },
 * }
 */

function addNewPallet() {
  if (!State.order) {
    showToast('Load an order first.', 'error');
    return;
  }

  const id    = State.pallets.length + 1;
  const sscc  = nextSSCC();
  const rawOrder = State.order.sale_order || State.order.order_id || '';
  const orderId = rawOrder.replace(/^SO/, 'S');

  // If this is the first pallet, auto-assign all order lines with their full quantity
  const initialLines = {};
  if (State.pallets.length === 0 && State.moveLines && State.moveLines.length > 0) {
    State.moveLines.forEach((m, idx) => {
      const qty = m.qty_done || m.qty_demand || 0;
      if (qty > 0) {
        initialLines[idx] = { lineIdx: idx, qty };
      }
    });
  }

  const pallet = {
    id,
    label: `${orderId} - Pallet ${id}`,
    sscc,
    lines: initialLines,
  };

  State.pallets.push(pallet);
  State.activePalletIndex = State.pallets.length - 1;

  renderPalletTabs();
  renderOrderLinesTable();
  refreshPalletSummary();
  autoUpdateCustomizerFromPallet();

  showToast(`Pallet ${id} created (SSCC: ${sscc})`, 'success');
}

function renderPalletTabs() {
  const container = document.getElementById('pallet-tabs');
  const countLabel = document.getElementById('pallet-count-label');

  countLabel.textContent = `${State.pallets.length} pallet${State.pallets.length !== 1 ? 's' : ''}`;

  container.innerHTML = State.pallets.map((p, i) => {
    const isActive = i === State.activePalletIndex;
    const totalBoxes = Object.values(p.lines).reduce((sum, l) => sum + (l.qty || 0), 0);

    return `
      <div class="pallet-card p-3 min-w-32 ${isActive ? 'active' : ''}" onclick="selectPallet(${i})">
        <div class="text-xs font-bold text-slate-800 mb-1">📦 Pallet ${p.id}</div>
        <div class="text-xs text-blue-600 font-semibold font-mono">${totalBoxes} items</div>
        <div class="text-xs text-slate-500 font-mono truncate mt-1" title="${p.sscc}">${p.sscc.slice(0, 10)}…</div>
        <div class="flex gap-1 mt-2">
          <button class="btn-danger text-xs py-0.5 px-1.5" onclick="event.stopPropagation(); deletePallet(${i})">✕</button>
        </div>
      </div>
    `;
  }).join('');
}

function selectPallet(index) {
  State.activePalletIndex = index;
  renderPalletTabs();
  renderOrderLinesTable();
  refreshPalletSummary();
  autoUpdateCustomizerFromPallet();
}

function deletePallet(index) {
  if (!confirm(`Delete Pallet ${State.pallets[index].id}?`)) return;
  State.pallets.splice(index, 1);

  if (State.pallets.length === 0) {
    State.activePalletIndex = -1;
  } else {
    State.activePalletIndex = Math.min(State.activePalletIndex, State.pallets.length - 1);
  }

  renderPalletTabs();
  renderOrderLinesTable();
  refreshPalletSummary();
  autoUpdateCustomizerFromPallet();
}

function refreshPalletSummary() {
  const container = document.getElementById('pallet-contents');
  if (State.activePalletIndex < 0 || !State.pallets.length) {
    container.innerHTML = '<p class="text-slate-500">No active pallet. Click a pallet tab or "New Pallet".</p>';
    return;
  }

  const pallet = State.pallets[State.activePalletIndex];
  const entries = Object.values(pallet.lines).filter(l => l.qty > 0);

  if (!entries.length) {
    container.innerHTML = '<p class="text-slate-500 text-sm">No items assigned. Use the "Pallet Qty" column to assign quantities.</p>';
    return;
  }

  container.innerHTML = entries.map(e => {
    const line = State.moveLines[e.lineIdx];
    return `
      <div class="flex items-center justify-between glass-card-light px-3 py-2">
        <div>
          <div class="text-sm font-medium text-slate-800">${escapeHtml(line.product_name)}</div>
          ${line.barcode ? `<div class="text-xs font-mono text-slate-500">${escapeHtml(line.barcode)}</div>` : ''}
        </div>
        <div class="qty-cell text-sm">${e.qty}</div>
      </div>
    `;
  }).join('');
}

/**
 * Auto-populate customizer fields from the active pallet state.
 */
function autoUpdateCustomizerFromPallet() {
  if (State.activePalletIndex < 0) return;
  const pallet  = State.pallets[State.activePalletIndex];
  if (!pallet) return;

  const orderId = State.order?.order_id || '';
  const displayOrderNo = State.order?.sale_order || orderId;
  const shortId = displayOrderNo.replace(/^SO/, 'S');

  const totalBoxes = Object.values(pallet.lines || {}).reduce((sum, l) => sum + (l.qty || 0), 0);
  const palletTitle = `${shortId} - Pallet ${pallet.id} - ${totalBoxes} boxes`;

  // Update customizer DOM inputs
  setInputValue('lbl-pallet-title', palletTitle);
  setInputValue('lbl-order-number', displayOrderNo);
  setInputValue('lbl-sscc', pallet.sscc);

  const catInput = document.getElementById('lbl-category');
  const categoryVal = catInput?.value?.trim() || 'Mixed Goods Shipment';
  setInputValue('lbl-category', categoryVal);

  if (State.order?.client_order_ref) {
    State.label.orderRef = State.order.client_order_ref;
  }

  // Build items list for customizer
  const items = Object.values(pallet.lines || {})
    .filter(l => l.qty > 0)
    .map(e => {
      const line = State.moveLines[e.lineIdx] || {};
      const existing = State.label.items?.find(it => it.productName === (line.product_name || ''));
      return {
        gtin: line.barcode || '',
        productName: line.product_name || '',
        qtyText: `${e.qty} pcs`,
        descOverride: existing?.descOverride || '',
      };
    });

  State.label.items       = items;
  State.label.palletTitle = palletTitle;
  State.label.category    = categoryVal;
  State.label.orderNumber = displayOrderNo;
  State.label.sscc        = pallet.sscc;

  renderItemDescInputs(items);
  syncLabelPreview();
}

function commitPalletContents() {
  autoUpdateCustomizerFromPallet();
  showToast('Label preview updated.', 'success');
}

// ═══════════════════════════════════════════════════════════════
// §8  LABEL CUSTOMIZER & PREVIEW SYNC
// ═══════════════════════════════════════════════════════════════

/**
 * Called whenever any customizer input changes.
 * Reads all fields → updates State.label → syncs preview.
 */
function onCustomizerChange() {
  State.label.palletTitle  = (document.getElementById('lbl-pallet-title')?.value || '').trim();
  State.label.category     = (document.getElementById('lbl-category')?.value || '').trim();
  State.label.orderNumber  = (document.getElementById('lbl-order-number')?.value || '').trim();
  State.label.sscc         = (document.getElementById('lbl-sscc')?.value || '').trim();

  // Sync SSCC to active pallet
  if (State.activePalletIndex >= 0 && State.pallets[State.activePalletIndex]) {
    State.pallets[State.activePalletIndex].sscc = State.label.sscc;
  }

  // Read item desc overrides
  if (Array.isArray(State.label.items)) {
    State.label.items.forEach((item, i) => {
      const overrideEl = document.getElementById(`item-desc-${i}`);
      if (overrideEl) item.descOverride = overrideEl.value;
    });
  }

  syncLabelPreview();
}

/**
 * Renders individual override text inputs for each item.
 */
function renderItemDescInputs(items) {
  const container = document.getElementById('item-desc-inputs');
  if (!items || !items.length) {
    container.innerHTML = '<p class="text-xs text-slate-600">No items assigned to active pallet.</p>';
    return;
  }

  container.innerHTML = items.map((item, i) => `
    <div class="flex gap-2 items-center">
      <span class="text-xs text-slate-500 w-5 text-right">${i + 1}.</span>
      <input type="text"
             id="item-desc-${i}"
             class="form-input text-xs"
             value="${escapeHtml(item.descOverride || item.productName)}"
             placeholder="${escapeHtml(item.productName)}"
             oninput="onCustomizerChange()" />
      <span class="text-xs font-mono text-blue-600 font-medium whitespace-nowrap">${item.qtyText}</span>
    </div>
  `).join('');
}

/**
 * Push State.label data into the label canvas DOM elements.
 */
function syncLabelPreview() {
  // Title
  setText('lbl-display-title', State.label.palletTitle || '—');

  // Category
  setText('lbl-display-category', State.label.category || '—');

  // Order number
  setText('lbl-display-order', State.label.orderNumber || '—');

  // SSCC
  setText('lbl-display-sscc', State.label.sscc || '—');

  // Items list
  const itemsContainer = document.getElementById('lbl-display-items');
  if (itemsContainer) {
    if (!State.label.items || !State.label.items.length) {
      itemsContainer.innerHTML = '<div class="text-gray-400 italic">No items assigned</div>';
    } else {
      itemsContainer.innerHTML = State.label.items.map(item => {
        const desc    = item.descOverride || item.productName;
        const gtin    = item.gtin;
        const qtyTxt  = item.qtyText;
        return `
          <div class="item-row">
            ${gtin ? `<span class="item-gtin">[${escapeHtml(gtin)}]</span>` : ''}
            <span class="item-name">${escapeHtml(desc)}</span>
            <span class="item-qty">${escapeHtml(qtyTxt)}</span>
          </div>
        `;
      }).join('');
    }
  }

  // Barcodes
  renderAllBarcodes();
}

function regenerateSSCC() {
  const sscc = nextSSCC();

  // Assign to active pallet
  if (State.activePalletIndex >= 0 && State.pallets[State.activePalletIndex]) {
    State.pallets[State.activePalletIndex].sscc = sscc;
  }

  setInputValue('lbl-sscc', sscc);
  State.label.sscc = sscc;
  syncLabelPreview();
  showToast(`New SSCC: ${sscc}`, 'info');
}

// ═══════════════════════════════════════════════════════════════
// §9  PRINT PROTOCOL
// ═══════════════════════════════════════════════════════════════

function printLabel() {
  onCustomizerChange();

  const currentSSCC = (State.label.sscc || document.getElementById('lbl-sscc')?.value || '').trim();

  if (!currentSSCC || currentSSCC.length !== 18) {
    showToast(`SSCC must be 18 digits before printing (currently ${currentSSCC ? currentSSCC.length : 0} digits).`, 'error');
    return;
  }

  const title = (State.label.palletTitle || document.getElementById('lbl-pallet-title')?.value || '').trim();
  if (!title) {
    showToast('Please set a Pallet Title before printing.', 'error');
    return;
  }

  State.label.sscc = currentSSCC;
  State.label.palletTitle = title;
  syncLabelPreview();

  window.print();
}

// ═══════════════════════════════════════════════════════════════
// §10 UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════

function clearWorkspace() {
  if (!confirm('Clear current order and all pallets?')) return;
  State.order = null;
  State.moveLines = [];
  State.pallets = [];
  State.activePalletIndex = -1;
  State.label = {
    palletTitle: '', category: '', orderNumber: '', sscc: '',
    items: [], orderRef: State.label.orderRef,
  };

  document.getElementById('main-workspace').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('order-input').value = '';

  syncLabelPreview();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text ?? '';
}

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value ?? '';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setButtonLoading(btn, loading, loadingText = 'Loading…', originalHtml = '') {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${loadingText}`;
  } else {
    btn.disabled = false;
    if (originalHtml) btn.innerHTML = originalHtml;
  }
}

function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ═══════════════════════════════════════════════════════════════
// §11  INITIALISATION
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // Render empty barcodes with default values
  State.label.orderRef = '9202851073';
  renderAllBarcodes();

  // Demo SSCC in label preview to show structure
  const demoSSCC = buildSSCC(
    State.config.extension_digit,
    State.config.gs1_company_prefix,
    State.config.sscc_start_serial
  );
  setText('lbl-display-sscc', demoSSCC);
  setText('barcode-sscc-text', `(00)${demoSSCC}`);
  setInputValue('lbl-sscc', demoSSCC);
  State.label.sscc = demoSSCC;

  console.log('%c🏷 GS1 Label Printer Ready', 'color:#6366f1; font-size:14px; font-weight:bold;');
  console.log('  SSCC Engine test:', demoSSCC, '(', demoSSCC.length, 'digits)');

  // Check authentication status
  const isAuth = await checkAuthStatus();
  if (isAuth) {
    await loadConfig();
  }
});

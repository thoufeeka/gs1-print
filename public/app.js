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

function applyUserRoleUI(username, role = 'user') {
  const isAdmin = role === 'admin';
  State.user = { username: username || 'user', role: isAdmin ? 'admin' : 'user' };

  const nameEl = document.getElementById('user-display-name');
  if (nameEl) {
    nameEl.innerHTML = `${escapeHtml(State.user.username)} <span class="badge ${isAdmin ? 'badge-assigned' : 'badge-draft'} ml-1">${isAdmin ? 'ADMIN' : 'USER'}</span>`;
  }

  // Only Admin can view or toggle the Settings tray & Serial Override
  const settingsBtn = document.getElementById('settings-toggle-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const settingsTray = document.getElementById('settings-tray');

  if (settingsBtn) {
    if (isAdmin) {
      settingsBtn.classList.remove('hidden');
    } else {
      settingsBtn.classList.add('hidden');
    }
  }
  if (!isAdmin) {
    if (settingsTray) settingsTray.classList.remove('open');
    if (settingsPanel) settingsPanel.classList.add('hidden');
  } else if (settingsPanel) {
    settingsPanel.classList.remove('hidden');
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
      applyUserRoleUI(data.username || 'admin', data.role || 'user');
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
    applyUserRoleUI(data.username || username, data.role || 'user');
    showLoginModal(false);
    showToast(`Signed in as ${data.username || username} (${(data.role || 'user').toUpperCase()})`, 'success');

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
    labelType: 'Mixed Trade Item',
    clientRef: '504772',
    palletTitle: '',
    productCategory: 'MASECZKI W PŁACHCIE D/TW ABIB 27 ml MIX - 781648',
    orderNumber: '9202851073',
    sscc: '',
    items: [],          // [{ lineIdx, gtin, productName, qtyText, descOverride, qtyOverride }]
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
 * Generate the next local SSCC using current State config and increment the counter,
 * ensuring it has never been used in localStorage history.
 * @returns {string}
 */
function nextSSCC() {
  const savedLast = parseInt(localStorage.getItem('gs1_last_serial') || '0', 10);
  if (savedLast >= State.nextSerial) {
    State.nextSerial = savedLast + 1;
  }

  let usedSet = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem('gs1_used_ssccs') || '[]');
    if (Array.isArray(raw)) usedSet = new Set(raw);
  } catch (_) {}

  // Also include any SSCCs currently on active pallets
  (State.pallets || []).forEach(p => {
    if (p?.sscc) usedSet.add(p.sscc);
  });

  let sscc = buildSSCC(
    State.config.extension_digit,
    State.config.gs1_company_prefix,
    State.nextSerial
  );

  while (usedSet.has(sscc)) {
    State.nextSerial++;
    sscc = buildSSCC(
      State.config.extension_digit,
      State.config.gs1_company_prefix,
      State.nextSerial
    );
  }

  localStorage.setItem('gs1_last_serial', String(State.nextSerial));
  usedSet.add(sscc);
  try {
    localStorage.setItem('gs1_used_ssccs', JSON.stringify([...usedSet].slice(-2000)));
  } catch (_) {}

  State.nextSerial++;
  setText('cfg-sscc-serial', State.nextSerial);
  const overrideInput = document.getElementById('serial-override-input');
  if (overrideInput) overrideInput.value = State.nextSerial;
  updateSettingsPreview();
  return sscc;
}

/**
 * Allocate a guaranteed-unique SSCC from the backend (Supabase atomic sequence + registry)
 * with instant local fallback.
 */
async function allocateUniqueSSCC(orderId = '', palletId = null) {
  try {
    const res = await fetch('/api/sscc/allocate', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ order_id: orderId, pallet_id: palletId }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.sscc && data.sscc.length === 18) {
        if (Number.isFinite(data.serial)) {
          localStorage.setItem('gs1_last_serial', String(data.serial));
          State.nextSerial = Math.max(State.nextSerial, data.serial + 1);
          setText('cfg-sscc-serial', State.nextSerial);
          const overrideInput = document.getElementById('serial-override-input');
          if (overrideInput) overrideInput.value = State.nextSerial;
          updateSettingsPreview();
        }
        try {
          const used = new Set(JSON.parse(localStorage.getItem('gs1_used_ssccs') || '[]'));
          used.add(data.sscc);
          localStorage.setItem('gs1_used_ssccs', JSON.stringify([...used].slice(-2000)));
        } catch (_) {}
        return data.sscc;
      }
    }
  } catch (err) {
    console.warn('[SSCC] Server allocation fallback to local:', err.message);
  }
  return nextSSCC();
}

// ─── Order & Pallet State Persistence (Supabase + Local Backup) ──────────────
let saveStateTimer = null;

function getOrderStorageKey(orderData = State.order) {
  if (!orderData) return '';
  const key = (orderData.sale_order || orderData.order_id || '').trim().toUpperCase();
  return key ? `gs1_order_state_${key}` : '';
}

function scheduleSaveOrderState() {
  if (!State.order) return;
  // Save immediately to localStorage for zero-latency recovery
  try {
    const localKey = getOrderStorageKey();
    if (localKey) {
      localStorage.setItem(localKey, JSON.stringify({
        order_id: State.order.order_id,
        sale_order: State.order.sale_order,
        pallets: State.pallets,
        active_pallet_index: State.activePalletIndex,
        updated_at: new Date().toISOString(),
      }));
    }
  } catch (_) {}

  // Debounce cloud database save (350ms)
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveOrderStateNow();
  }, 350);
}

async function saveOrderStateNow() {
  if (!State.order) return;
  try {
    await fetch('/api/order-state', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        order_id: State.order.order_id,
        sale_order: State.order.sale_order,
        pallets: State.pallets,
        active_pallet_index: State.activePalletIndex,
      }),
    });
  } catch (err) {
    console.warn('[OrderState] Cloud sync warning:', err.message);
  }
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

let serialOverrideTimer = null;

function updateSerialOverride(val) {
  if (State.user?.role !== 'admin') return;
  const n = parseInt(val, 10);
  if (!isNaN(n) && n >= 1) {
    State.nextSerial = n;
    setText('cfg-sscc-serial', n);
    updateSettingsPreview();

    if (serialOverrideTimer) clearTimeout(serialOverrideTimer);
    serialOverrideTimer = setTimeout(async () => {
      try {
        await fetch('/api/sscc/set-serial', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ next_serial: n }),
        });
      } catch (_) {}
    }, 500);
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

  try {
    JsBarcode(`#${svgId}`, value, {
      format: 'CODE128',
      width: 1.55,
      height: 58,
      displayValue: false,      // we render human-readable text separately
      margin: 0,
      background: '#ffffff',
      lineColor: '#000000',
    });
  } catch (err) {
    console.warn(`[Barcode] Render failed for ${svgId}:`, err.message);
    el.innerHTML = `<text x="10" y="20" font-size="10" fill="red">Error: ${err.message}</text>`;
  }
}

function renderAllBarcodes() {
  const orderRef = (State.label.orderNumber || State.label.orderRef || '9202851073').trim();
  const sscc     = (State.label.sscc || '').trim();

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
    await initWorkspace(data);
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

async function initWorkspace(data) {
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

  // Check if saved pallet & customizer state exists in Supabase or localStorage
  let savedState = data.saved_state || null;
  if (!savedState || !Array.isArray(savedState.pallets) || savedState.pallets.length === 0) {
    try {
      const localRaw = localStorage.getItem(getOrderStorageKey(data));
      if (localRaw) {
        const parsed = JSON.parse(localRaw);
        if (parsed && Array.isArray(parsed.pallets) && parsed.pallets.length > 0) {
          savedState = parsed;
        }
      }
    } catch (_) {}
  }

  if (savedState && Array.isArray(savedState.pallets) && savedState.pallets.length > 0) {
    State.pallets = savedState.pallets.map(p => ensurePalletCustomizer(p));
    State.activePalletIndex = Math.max(0, Math.min(savedState.active_pallet_index ?? 0, State.pallets.length - 1));
    renderPalletTabs();
    renderOrderLinesTable();
    refreshPalletSummary();
    autoUpdateCustomizerFromPallet();
    showToast(`Restored ${State.pallets.length} saved pallet(s) for ${data.sale_order || data.order_id}`, 'info');
    return;
  }

  // Render lines table & auto-create pallet 1 for fresh order
  renderOrderLinesTable();
  State.pallets = [];
  State.activePalletIndex = -1;
  await addNewPallet();
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

  renderPalletTabs();
  refreshPalletSummary();
  autoUpdateCustomizerFromPallet();
  scheduleSaveOrderState();
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
 *   customizer: {
 *     palletTitle: string,
 *     isCustomTitle: boolean,
 *     category: string,
 *     orderNumber: string,
 *     isCustomOrderNo: boolean,
 *     itemOverrides: { [lineIdx]: string }
 *   }
 * }
 */

function ensurePalletCustomizer(pallet) {
  if (!pallet) return pallet;
  if (!pallet.customizer || typeof pallet.customizer !== 'object') {
    pallet.customizer = {
      labelType: 'Mixed Trade Item',
      clientRef: '504772',
      palletTitle: '',
      isCustomTitle: false,
      productCategory: 'MASECZKI W PŁACHCIE D/TW ABIB 27 ml MIX - 781648',
      orderNumber: '',
      isCustomOrderNo: false,
      itemOverrides: {},
      qtyOverrides: {},
    };
  }
  if (!pallet.customizer.labelType) {
    pallet.customizer.labelType = 'Mixed Trade Item';
  }
  if (pallet.customizer.clientRef === undefined) {
    pallet.customizer.clientRef = '504772';
  }
  if (pallet.customizer.productCategory === undefined) {
    pallet.customizer.productCategory = pallet.customizer.category && pallet.customizer.category !== 'Mixed Goods Shipment'
      ? pallet.customizer.category
      : 'MASECZKI W PŁACHCIE D/TW ABIB 27 ml MIX - 781648';
  }
  if (!pallet.customizer.itemOverrides || typeof pallet.customizer.itemOverrides !== 'object') {
    pallet.customizer.itemOverrides = {};
  }
  if (!pallet.customizer.qtyOverrides || typeof pallet.customizer.qtyOverrides !== 'object') {
    pallet.customizer.qtyOverrides = {};
  }
  return pallet;
}

function getDefaultPalletTitle(pallet) {
  const orderId = State.order?.order_id || '';
  const displayOrderNo = State.order?.sale_order || orderId;
  const shortId = displayOrderNo.replace(/^SO/, 'S');
  const totalBoxes = Object.values(pallet?.lines || {}).reduce((sum, l) => sum + (l.qty || 0), 0);
  return `${shortId} - Pallet ${pallet?.id || 1} - ${totalBoxes} boxes`;
}

async function addNewPallet() {
  if (!State.order) {
    showToast('Load an order first.', 'error');
    return;
  }

  // Save current pallet's customizer edits before switching
  if (State.activePalletIndex >= 0 && State.pallets[State.activePalletIndex]) {
    onCustomizerChange(false);
  }

  const maxId = State.pallets.reduce((max, p) => Math.max(max, p.id || 0), 0);
  const id    = maxId + 1;
  const rawOrder = State.order.sale_order || State.order.order_id || '';
  const orderId = rawOrder.replace(/^SO/, 'S');
  const sscc  = await allocateUniqueSSCC(rawOrder, id);

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

  const pallet = ensurePalletCustomizer({
    id,
    label: `${orderId} - Pallet ${id}`,
    sscc,
    lines: initialLines,
  });

  State.pallets.push(pallet);
  State.activePalletIndex = State.pallets.length - 1;

  renderPalletTabs();
  renderOrderLinesTable();
  refreshPalletSummary();
  autoUpdateCustomizerFromPallet();
  scheduleSaveOrderState();

  showToast(`Pallet ${id} created (SSCC: ${sscc})`, 'success');
}

function renderPalletTabs() {
  const container = document.getElementById('pallet-tabs');
  const countLabel = document.getElementById('pallet-count-label');

  countLabel.textContent = `${State.pallets.length} pallet${State.pallets.length !== 1 ? 's' : ''}`;

  container.innerHTML = State.pallets.map((p, i) => {
    const isActive = i === State.activePalletIndex;
    const totalBoxes = Object.values(p.lines || {}).reduce((sum, l) => sum + (l.qty || 0), 0);

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
  // Save edits on the currently active pallet before switching
  if (State.activePalletIndex >= 0 && State.activePalletIndex !== index && State.pallets[State.activePalletIndex]) {
    onCustomizerChange(false);
  }
  State.activePalletIndex = index;
  renderPalletTabs();
  renderOrderLinesTable();
  refreshPalletSummary();
  autoUpdateCustomizerFromPallet();
  scheduleSaveOrderState();
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
  scheduleSaveOrderState();
}

function refreshPalletSummary() {
  const container = document.getElementById('pallet-contents');
  if (State.activePalletIndex < 0 || !State.pallets.length) {
    container.innerHTML = '<p class="text-slate-500">No active pallet. Click a pallet tab or "New Pallet".</p>';
    return;
  }

  const pallet = State.pallets[State.activePalletIndex];
  const entries = Object.values(pallet.lines || {}).filter(l => l.qty > 0);

  if (!entries.length) {
    container.innerHTML = '<p class="text-slate-500 text-sm">No items assigned. Use the "Pallet Qty" column to assign quantities.</p>';
    return;
  }

  container.innerHTML = entries.map(e => {
    const line = State.moveLines[e.lineIdx];
    if (!line) return '';
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
 * Populate customizer fields from the active pallet's stored customizer state
 * (preserving any custom user edits made on this pallet).
 */
function autoUpdateCustomizerFromPallet() {
  if (State.activePalletIndex < 0) return;
  const pallet = ensurePalletCustomizer(State.pallets[State.activePalletIndex]);
  if (!pallet) return;

  const orderId = State.order?.order_id || '';
  const defaultOrderNo = State.order?.client_order_ref || State.order?.sale_order || orderId || '9202851073';
  const defaultTitle = getDefaultPalletTitle(pallet);

  const labelTypeVal = pallet.customizer.labelType || 'Mixed Trade Item';
  const clientRefVal = pallet.customizer.clientRef !== undefined ? pallet.customizer.clientRef : '504772';
  const productCategoryVal = pallet.customizer.productCategory !== undefined
    ? pallet.customizer.productCategory
    : 'MASECZKI W PŁACHCIE D/TW ABIB 27 ml MIX - 781648';

  const palletTitle = (pallet.customizer.isCustomTitle && pallet.customizer.palletTitle)
    ? pallet.customizer.palletTitle
    : defaultTitle;

  const displayOrderNo = (pallet.customizer.isCustomOrderNo && pallet.customizer.orderNumber)
    ? pallet.customizer.orderNumber
    : defaultOrderNo;

  // Update customizer DOM inputs
  setInputValue('lbl-type', labelTypeVal);
  setInputValue('lbl-client-ref', clientRefVal);
  setInputValue('lbl-pallet-title', palletTitle);
  setInputValue('lbl-product-category', productCategoryVal);
  setInputValue('lbl-order-number', displayOrderNo);
  setInputValue('lbl-sscc', pallet.sscc);

  State.label.orderRef = displayOrderNo;

  // Build items list for customizer, restoring per-pallet itemOverrides and qtyOverrides by lineIdx
  const items = Object.values(pallet.lines || {})
    .filter(l => l.qty > 0)
    .map(e => {
      const line = State.moveLines[e.lineIdx] || {};
      const savedDescOverride = pallet.customizer.itemOverrides?.[e.lineIdx];
      const defaultQtyTxt = `${e.qty} pcs`;
      const savedQtyOverride = pallet.customizer.qtyOverrides?.[e.lineIdx];
      return {
        lineIdx: e.lineIdx,
        gtin: line.barcode || '',
        productName: line.product_name || '',
        qtyText: defaultQtyTxt,
        descOverride: savedDescOverride !== undefined ? savedDescOverride : (line.product_name || ''),
        qtyOverride: savedQtyOverride !== undefined ? savedQtyOverride : defaultQtyTxt,
      };
    });

  State.label.labelType       = labelTypeVal;
  State.label.clientRef       = clientRefVal;
  State.label.palletTitle     = palletTitle;
  State.label.productCategory = productCategoryVal;
  State.label.orderNumber     = displayOrderNo;
  State.label.sscc            = pallet.sscc;
  State.label.items           = items;

  renderItemDescInputs(items);
  syncLabelPreview();
}

function commitPalletContents() {
  autoUpdateCustomizerFromPallet();
  scheduleSaveOrderState();
  showToast('Label preview updated & saved.', 'success');
}

// ═══════════════════════════════════════════════════════════════
// §8  LABEL CUSTOMIZER & PREVIEW SYNC
// ═══════════════════════════════════════════════════════════════

/**
 * Called whenever any customizer input changes.
 * Reads all fields → saves into active pallet's customizer state → updates State.label → syncs preview.
 */
function onCustomizerChange(shouldPersist = true) {
  const labelTypeVal   = (document.getElementById('lbl-type')?.value || 'Mixed Trade Item').trim();
  const clientRefVal   = (document.getElementById('lbl-client-ref')?.value ?? '504772').trim();
  const titleVal       = (document.getElementById('lbl-pallet-title')?.value || '').trim();
  const prodCatVal     = (document.getElementById('lbl-product-category')?.value ?? '').trim();
  const orderNoVal     = (document.getElementById('lbl-order-number')?.value || '').trim();
  const ssccVal        = (document.getElementById('lbl-sscc')?.value || '').trim();

  State.label.labelType       = labelTypeVal;
  State.label.clientRef       = clientRefVal;
  State.label.palletTitle     = titleVal;
  State.label.productCategory = prodCatVal;
  State.label.orderNumber     = orderNoVal;
  State.label.orderRef        = orderNoVal || '9202851073';
  State.label.sscc            = ssccVal;

  // Read item desc & qty/multiplier overrides
  if (Array.isArray(State.label.items)) {
    State.label.items.forEach((item, i) => {
      const overrideEl = document.getElementById(`item-desc-${i}`);
      if (overrideEl) item.descOverride = overrideEl.value;
      const qtyOverrideEl = document.getElementById(`item-qty-${i}`);
      if (qtyOverrideEl) item.qtyOverride = qtyOverrideEl.value;
    });
  }

  // Persist customizer edits onto the active pallet object so switching pallets never loses edits
  if (State.activePalletIndex >= 0 && State.pallets[State.activePalletIndex]) {
    const pallet = ensurePalletCustomizer(State.pallets[State.activePalletIndex]);
    pallet.sscc = ssccVal;
    pallet.customizer.labelType = labelTypeVal;
    pallet.customizer.clientRef = clientRefVal;
    pallet.customizer.productCategory = prodCatVal;

    const defaultTitle = getDefaultPalletTitle(pallet);
    if (titleVal && titleVal !== defaultTitle) {
      pallet.customizer.isCustomTitle = true;
      pallet.customizer.palletTitle = titleVal;
    } else if (!titleVal || titleVal === defaultTitle) {
      pallet.customizer.isCustomTitle = false;
      pallet.customizer.palletTitle = defaultTitle;
    }

    const defaultOrderNo = State.order?.client_order_ref || State.order?.sale_order || State.order?.order_id || '9202851073';
    if (orderNoVal && orderNoVal !== defaultOrderNo) {
      pallet.customizer.isCustomOrderNo = true;
      pallet.customizer.orderNumber = orderNoVal;
    } else {
      pallet.customizer.isCustomOrderNo = false;
      pallet.customizer.orderNumber = defaultOrderNo;
    }

    if (Array.isArray(State.label.items)) {
      State.label.items.forEach(item => {
        if (item.lineIdx !== undefined) {
          pallet.customizer.itemOverrides[item.lineIdx] = item.descOverride;
          pallet.customizer.qtyOverrides[item.lineIdx]  = item.qtyOverride;
        }
      });
    }
  }

  syncLabelPreview();
  if (shouldPersist) {
    scheduleSaveOrderState();
  }
}

/**
 * Renders individual override text inputs for each item (Product Description + Multiplier/Qty).
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
             class="form-input text-xs flex-1"
             value="${escapeHtml(item.descOverride ?? item.productName)}"
             placeholder="${escapeHtml(item.productName)}"
             oninput="onCustomizerChange()"
             title="Product Description" />
      <input type="text"
             id="item-qty-${i}"
             class="form-input text-xs font-mono w-36"
             value="${escapeHtml(item.qtyOverride ?? item.qtyText)}"
             placeholder="e.g. 15 x 66 = 990 pcs"
             oninput="onCustomizerChange()"
             title="Multiplier / Total Qty (e.g. 15 x 66 = 990 pcs)" />
    </div>
  `).join('');
}

/**
 * Push State.label data into the label canvas DOM elements.
 */
function syncLabelPreview() {
  // Sender Internal Client Ref (under Liwela GmbH)
  setText('lbl-display-client-ref', State.label.clientRef || '504772');

  // Pallet Title (Bold)
  setText('lbl-display-title', State.label.palletTitle || '—');

  // Product Category Name
  setText('lbl-display-product-category', State.label.productCategory || '');

  // Order number
  setText('lbl-display-order', State.label.orderNumber || '—');

  // SSCC
  setText('lbl-display-sscc', State.label.sscc || '—');

  // Items list — formatted identically to GS1 Mixed Trade Item print specification:
  // "8800280693419 - Abib Madecassoside Soothing Sheet Mask Essential Fit: 15 x 66 = 990 pcs"
  const itemsContainer = document.getElementById('lbl-display-items');
  if (itemsContainer) {
    if (!State.label.items || !State.label.items.length) {
      itemsContainer.innerHTML = '<div class="item-line">—</div>';
    } else {
      itemsContainer.innerHTML = State.label.items.map(item => {
        const rawDesc = (item.descOverride ?? item.productName ?? '').trim();
        const cleanDesc = rawDesc.replace(/:+\s*$/, '');
        const gtin = (item.gtin || '').trim();
        const qtyTxt = (item.qtyOverride ?? item.qtyText ?? '').trim();
        const prefix = gtin ? `${escapeHtml(gtin)} - ` : '';
        const suffix = qtyTxt ? `: ${escapeHtml(qtyTxt)}` : '';
        return `<div class="item-line">${prefix}${escapeHtml(cleanDesc)}${suffix}</div>`;
      }).join('');
    }
  }

  // Barcodes
  renderAllBarcodes();
}

async function regenerateSSCC() {
  const rawOrder = State.order?.sale_order || State.order?.order_id || '';
  const activePallet = State.activePalletIndex >= 0 ? State.pallets[State.activePalletIndex] : null;
  const sscc = await allocateUniqueSSCC(rawOrder, activePallet?.id || null);

  // Assign to active pallet
  if (activePallet) {
    activePallet.sscc = sscc;
  }

  setInputValue('lbl-sscc', sscc);
  State.label.sscc = sscc;
  renderPalletTabs();
  syncLabelPreview();
  scheduleSaveOrderState();
  showToast(`New unique SSCC allocated: ${sscc}`, 'info');
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
    labelType: 'Mixed Trade Item',
    clientRef: '504772',
    palletTitle: '',
    productCategory: 'MASECZKI W PŁACHCIE D/TW ABIB 27 ml MIX - 781648',
    orderNumber: '9202851073',
    sscc: '',
    items: [],
    orderRef: '9202851073',
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

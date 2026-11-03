require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bwipjs = require('bwip-js');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Odoo 19 External JSON-2 API Helper ───────────────────────────────────────
// Odoo 19 External API uses /json/2/<model>/<method> with Bearer <API_KEY>
// and X-Odoo-Database header. Method kwargs are sent directly as JSON body.
const odooBaseUrl = () => {
  const url = (process.env.ODOO_URL || '').replace(/\/+$/, '');
  return url.startsWith('http') ? url : `https://${url}`;
};

const odooHeaders = () => {
  const apiKey = (process.env.ODOO_API_KEY || '').replace(/^"|"$/g, '').trim();
  const db = (process.env.ODOO_DB || '').trim();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'X-Odoo-Database': db,
  };
};

const odooCall = async (model, method, payload = {}) => {
  const url = `${odooBaseUrl()}/json/2/${model}/${method}`;
  return axios.post(url, payload, {
    headers: odooHeaders(),
    timeout: 15000,
  });
};

// ─── Supabase Cloud Persistence & Unique SSCC Engine ─────────────────────────
const supabaseConfig = () => {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').trim();
  const key = (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ''
  ).replace(/^"|"$/g, '').trim();
  return { url, key, enabled: !!(url && key) };
};

const supabaseHeaders = (extra = {}) => {
  const { key } = supabaseConfig();
  return {
    'Content-Type': 'application/json',
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    ...extra,
  };
};

// Server-side GS1 Mod-10 Check Digit & 18-digit SSCC Builder
function computeGS1CheckDigit(digits17) {
  let sumOdd = 0;
  let sumEven = 0;
  for (let i = 0; i < 17; i++) {
    const d = parseInt(digits17[i], 10);
    if ((i + 1) % 2 === 1) sumOdd += d;
    else sumEven += d;
  }
  return (10 - (((sumOdd * 3) + sumEven) % 10)) % 10;
}

function buildServerSSCC(serialNumber) {
  const ext = (process.env.SSCC_EXTENSION_DIGIT || '3').trim();
  const prefix = (process.env.GS1_COMPANY_PREFIX || '26249798').trim();
  const serialLen = 17 - 1 - prefix.length;
  const serialStr = String(serialNumber).padStart(serialLen, '0');
  const base17 = `${ext}${prefix}${serialStr}`;
  const check = computeGS1CheckDigit(base17);
  return `${base17}${check}`;
}

// Fallback in-memory state when Supabase is not yet configured
let memoryLastSerial = parseInt(process.env.SSCC_START_SERIAL || '1000', 10) - 1;
const memorySSCCRegistry = new Set();
const memoryOrderStates = new Map();

async function getNextUniqueSSCC(orderId = null, palletId = null) {
  const minStart = parseInt(process.env.SSCC_START_SERIAL || '1000', 10);
  const sb = supabaseConfig();

  if (sb.enabled) {
    try {
      // 1. Call atomic Postgres RPC function allocate_next_sscc_serial
      const rpcResp = await axios.post(
        `${sb.url}/rest/v1/rpc/allocate_next_sscc_serial`,
        { min_start_serial: minStart },
        { headers: supabaseHeaders(), timeout: 8000 }
      );
      let serial = Number(rpcResp.data);
      if (!Number.isFinite(serial) || serial < minStart) {
        serial = Math.max(memoryLastSerial + 1, minStart);
      }
      memoryLastSerial = Math.max(memoryLastSerial, serial);
      const sscc = buildServerSSCC(serial);

      // 2. Record in gs1_sscc_registry so it can never be reused
      await axios.post(
        `${sb.url}/rest/v1/gs1_sscc_registry`,
        {
          sscc,
          serial_number: serial,
          order_id: orderId || null,
          pallet_id: palletId || null,
        },
        { headers: supabaseHeaders({ 'Prefer': 'return=minimal' }), timeout: 8000 }
      );

      return { sscc, serial, persisted: true };
    } catch (err) {
      console.warn('[Supabase SSCC Allocate Fallback]', err.response?.data || err.message);
    }
  }

  // Fallback: strictly increment in memory & ensure never seen before
  let serial = Math.max(memoryLastSerial + 1, minStart);
  let sscc = buildServerSSCC(serial);
  while (memorySSCCRegistry.has(sscc)) {
    serial++;
    sscc = buildServerSSCC(serial);
  }
  memoryLastSerial = serial;
  memorySSCCRegistry.add(sscc);
  return { sscc, serial, persisted: false };
}

async function getSavedOrderState(orderId, saleOrder) {
  const sb = supabaseConfig();
  const keys = [...new Set([orderId, saleOrder].filter(Boolean).map(k => String(k).trim().toUpperCase()))];
  if (!keys.length) return null;

  if (sb.enabled) {
    try {
      const inList = keys.map(k => `"${k.replace(/"/g, '')}"`).join(',');
      const resp = await axios.get(
        `${sb.url}/rest/v1/gs1_order_states?order_id=in.(${encodeURIComponent(inList)})&order=updated_at.desc&limit=1`,
        { headers: supabaseHeaders(), timeout: 8000 }
      );
      if (Array.isArray(resp.data) && resp.data.length > 0) {
        return resp.data[0];
      }
    } catch (err) {
      console.warn('[Supabase Fetch Order State Warning]', err.response?.data || err.message);
    }
  }

  for (const k of keys) {
    if (memoryOrderStates.has(k)) return memoryOrderStates.get(k);
  }
  return null;
}

async function saveOrderStateToDb(orderId, saleOrder, pallets, activePalletIndex = 0) {
  const canonicalKey = String(saleOrder || orderId || '').trim().toUpperCase();
  if (!canonicalKey) return { saved: false };

  const record = {
    order_id: canonicalKey,
    sale_order: saleOrder || orderId || canonicalKey,
    pallets: Array.isArray(pallets) ? pallets : [],
    active_pallet_index: Number.isInteger(activePalletIndex) ? activePalletIndex : 0,
    updated_at: new Date().toISOString(),
  };

  memoryOrderStates.set(canonicalKey, record);
  if (orderId) memoryOrderStates.set(String(orderId).trim().toUpperCase(), record);

  const sb = supabaseConfig();
  if (sb.enabled) {
    try {
      await axios.post(
        `${sb.url}/rest/v1/gs1_order_states?on_conflict=order_id`,
        record,
        {
          headers: supabaseHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
          timeout: 8000,
        }
      );
      return { saved: true, persisted: true };
    } catch (err) {
      console.warn('[Supabase Save Order State Warning]', err.response?.data || err.message);
      return { saved: true, persisted: false, warning: err.response?.data?.message || err.message };
    }
  }
  return { saved: true, persisted: false };
}

// ─── Supabase User Authentication & Role-Based Tokens ────────────────────────
const revokedTokens = new Set();

const getAuthSecret = () => {
  return (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.ODOO_API_KEY ||
    'liwela-gs1-secret-2026'
  ).trim();
};

const createAuthToken = (username, role = 'user') => {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    r: role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
};

const verifyAuthToken = (token) => {
  if (!token || typeof token !== 'string' || revokedTokens.has(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.u || !data.exp || Date.now() > data.exp) return null;
    return { username: data.u, role: data.r || 'user' };
  } catch (_) {
    return null;
  }
};

// POST /api/login — Strictly authenticates against Supabase gs1_users table
app.post('/api/login', async (req, res) => {
  const rawUser = String(req.body?.username || '').trim();
  const rawPass = String(req.body?.password || '').trim();

  if (!rawUser || !rawPass) {
    return res.status(400).json({ success: false, error: 'Username and password are required.' });
  }

  const sb = supabaseConfig();
  if (!sb.enabled) {
    return res.status(500).json({ success: false, error: 'Supabase is not configured in .env.' });
  }

  try {
    const resp = await axios.get(
      `${sb.url}/rest/v1/gs1_users?username=eq.${encodeURIComponent(rawUser)}&active=eq.true&select=username,password,role&limit=1`,
      { headers: supabaseHeaders(), timeout: 8000 }
    );

    if (Array.isArray(resp.data) && resp.data.length > 0) {
      const dbUser = resp.data[0];
      if (String(dbUser.password).trim() === rawPass) {
        const role = dbUser.role === 'admin' ? 'admin' : 'user';
        const token = createAuthToken(dbUser.username, role);
        return res.json({ success: true, token, username: dbUser.username, role, source: 'supabase' });
      }
    }

    return res.status(401).json({ success: false, error: 'Invalid username or password.' });
  } catch (err) {
    console.error('[Supabase Auth Error]', err.response?.data || err.message);
    return res.status(502).json({
      success: false,
      error: 'Authentication database error: ' + (err.response?.data?.message || err.message),
    });
  }
});

// GET /api/auth-check
app.get('/api/auth-check', (req, res) => {
  const token = (req.headers['x-auth-token'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const user = verifyAuthToken(token);
  if (user) {
    return res.json({ authenticated: true, username: user.username, role: user.role });
  }
  return res.status(401).json({ authenticated: false });
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  const token = (req.headers['x-auth-token'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (token) revokedTokens.add(token);
  return res.json({ success: true });
});

// Middleware for protected routes
const requireAuth = (req, res, next) => {
  const token = (req.headers['x-auth-token'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const user = verifyAuthToken(token);
  if (user) {
    req.user = user;
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
};

// ─── GET /api/test-connection ────────────────────────────────────────────────
app.get('/api/test-connection', requireAuth, async (req, res) => {
  try {
    const testResp = await odooCall('res.partner', 'search_read', {
      domain: [],
      fields: ['id', 'name'],
      limit: 1
    });
    if (testResp.status === 200 && Array.isArray(testResp.data)) {
      return res.json({
        success: true,
        message: 'Successfully connected to Odoo 19 Online External JSON-2 API.',
        database: process.env.ODOO_DB,
      });
    }
    return res.status(502).json({ success: false, error: 'Unexpected response from Odoo.' });
  } catch (err) {
    console.error('[Odoo Connection Test Error]', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data?.message || err.message,
    });
  }
});

// ─── POST /api/fetch-order ────────────────────────────────────────────────────
app.post('/api/fetch-order', requireAuth, async (req, res) => {
  const { order_id } = req.body;
  if (!order_id || typeof order_id !== 'string') {
    return res.status(400).json({ error: 'order_id is required and must be a string.' });
  }

  const trimmedId = order_id.trim();
  if (!trimmedId) {
    return res.status(400).json({ error: 'order_id cannot be empty.' });
  }

  try {
    // ── Step 1: Search stock.picking (Deliveries) ─────────────────────────────
    let pickingsResp = await odooCall('stock.picking', 'search_read', {
      domain: [
        '|', '|', '|',
        ['origin', '=', trimmedId],
        ['name', '=', trimmedId],
        ['origin', 'ilike', trimmedId],
        ['name', 'ilike', trimmedId],
      ],
      fields: ['id', 'name', 'origin', 'state', 'partner_id', 'scheduled_date', 'date_done', 'picking_type_id', 'move_ids'],
      limit: 20,
    });

    let pickings = pickingsResp.data || [];
    let saleOrder = null;

    // ── Step 2: Fallback to sale.order if picking not found directly ──────────
    if (pickings.length === 0) {
      const saleResp = await odooCall('sale.order', 'search_read', {
        domain: [
          '|',
          ['name', 'ilike', trimmedId],
          ['client_order_ref', 'ilike', trimmedId],
        ],
        fields: ['id', 'name', 'partner_id', 'client_order_ref', 'state'],
        limit: 5,
      });

      const sales = saleResp.data || [];
      if (sales.length > 0) {
        saleOrder = sales[0];
        // Fetch pickings associated with this sale order
        const pickingsForSale = await odooCall('stock.picking', 'search_read', {
          domain: [['origin', '=', saleOrder.name]],
          fields: ['id', 'name', 'origin', 'state', 'partner_id', 'scheduled_date', 'date_done', 'picking_type_id', 'move_ids'],
          limit: 20,
        });
        pickings = pickingsForSale.data || [];
      }
    }

    if (pickings.length === 0) {
      return res.status(404).json({ error: `No deliveries or sales order found for "${trimmedId}".` });
    }

    // ── Step 3: Fetch stock.move lines ───────────────────────────────────────
    const allMoveIds = [...new Set(pickings.flatMap(p => p.move_ids || []))];
    let moveLines = [];

    if (allMoveIds.length > 0) {
      const moveResp = await odooCall('stock.move', 'search_read', {
        domain: [['id', 'in', allMoveIds]],
        fields: ['id', 'product_id', 'product_uom_qty', 'quantity', 'product_uom', 'picking_id', 'state', 'lot_ids', 'description_picking'],
        limit: 500,
      });
      moveLines = moveResp.data || [];
    }

    // ── Step 4: Fetch product details (barcodes, skus, weights) ──────────────
    const productIds = [...new Set(moveLines.map(m => m.product_id?.[0]).filter(Boolean))];
    let productMap = {};

    if (productIds.length > 0) {
      const prodResp = await odooCall('product.product', 'search_read', {
        domain: [['id', 'in', productIds]],
        fields: ['id', 'name', 'barcode', 'default_code', 'weight'],
        limit: 500,
      });
      (prodResp.data || []).forEach(p => { productMap[p.id] = p; });
    }

    // ── Step 5: Fetch lot/batch details (if any) ─────────────────────────────
    const allLotIds = [...new Set(moveLines.flatMap(m => m.lot_ids || []))];
    let lotMap = {};

    if (allLotIds.length > 0) {
      const lotResp = await odooCall('stock.lot', 'search_read', {
        domain: [['id', 'in', allLotIds]],
        fields: ['id', 'name', 'expiration_date'],
        limit: 200,
      });
      (lotResp.data || []).forEach(l => { lotMap[l.id] = l; });
    }

    // ── Step 6: Fetch partner / delivery address ──────────────────────────────
    const partnerId = pickings[0]?.partner_id?.[0] || saleOrder?.partner_id?.[0];
    let partnerInfo = null;

    if (partnerId) {
      const partnerResp = await odooCall('res.partner', 'search_read', {
        domain: [['id', '=', partnerId]],
        fields: ['id', 'name', 'street', 'street2', 'city', 'zip', 'country_id'],
        limit: 1,
      });
      if (partnerResp.data && partnerResp.data.length > 0) {
        partnerInfo = partnerResp.data[0];
      }
    }

    // ── Step 7: Assemble response ─────────────────────────────────────────────
    const enrichedMoves = moveLines.map(move => {
      const product = productMap[move.product_id?.[0]] || {};
      const lots = (move.lot_ids || []).map(lid => lotMap[lid]?.name).filter(Boolean);
      return {
        move_id: move.id,
        picking_id: move.picking_id?.[0],
        picking_name: move.picking_id?.[1],
        product_id: move.product_id?.[0],
        product_name: product.name || move.product_id?.[1] || move.description_picking || 'Product',
        product_ref: product.default_code || '',
        barcode: product.barcode || '',
        qty_demand: move.product_uom_qty || 0,
        qty_done: move.quantity || 0,
        uom: move.product_uom?.[1] || 'Units',
        state: move.state,
        lots: lots.join(', '),
        description: move.description_picking || '',
      };
    });

    const resolvedSaleOrder = saleOrder ? saleOrder.name : (pickings[0]?.origin || trimmedId);
    const savedState = await getSavedOrderState(trimmedId, resolvedSaleOrder);

    return res.json({
      order_id: trimmedId,
      sale_order: resolvedSaleOrder,
      client_order_ref: saleOrder?.client_order_ref || '',
      partner: partnerInfo,
      pickings: pickings.map(p => ({
        id: p.id,
        name: p.name,
        origin: p.origin,
        state: p.state,
        partner: p.partner_id?.[1] || '',
        picking_type: p.picking_type_id?.[1] || '',
        date: p.date_done || p.scheduled_date || '',
      })),
      move_lines: enrichedMoves,
      saved_state: savedState || null,
      config: {
        gs1_company_prefix: process.env.GS1_COMPANY_PREFIX || '26249798',
        sscc_start_serial: Math.max(memoryLastSerial + 1, parseInt(process.env.SSCC_START_SERIAL || '1000', 10)),
        extension_digit: process.env.SSCC_EXTENSION_DIGIT || '3',
        supabase_enabled: supabaseConfig().enabled,
      },
    });

  } catch (err) {
    console.error('[Server Error /api/fetch-order]', err.response?.data || err.message);
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      return res.status(502).json({ error: 'Cannot reach Odoo server. Check ODOO_URL in .env.' });
    }
    if (err.response?.status === 401 || err.response?.status === 403) {
      return res.status(401).json({ error: 'Odoo auth failed. Check ODOO_API_KEY in .env.' });
    }
    return res.status(500).json({
      error: 'Odoo API query failed.',
      detail: err.response?.data?.message || err.message,
    });
  }
});

// ─── POST /api/sscc/allocate ─────────────────────────────────────────────────
// Allocates a guaranteed-unique 18-digit SSCC from Supabase (or monotonic fallback)
app.post('/api/sscc/allocate', requireAuth, async (req, res) => {
  try {
    const { order_id, pallet_id } = req.body || {};
    const result = await getNextUniqueSSCC(order_id, pallet_id);
    return res.json(result);
  } catch (err) {
    console.error('[SSCC Allocate Error]', err.message);
    return res.status(500).json({ error: 'Failed to allocate unique SSCC.', detail: err.message });
  }
});

// ─── POST /api/sscc/set-serial (Admin Only) ──────────────────────────────────
// Updates the minimum starting SSCC serial counter in Supabase
app.post('/api/sscc/set-serial', requireAuth, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only Admin users can modify the SSCC serial counter.' });
  }
  const nextSerial = parseInt(req.body?.next_serial, 10);
  if (!Number.isFinite(nextSerial) || nextSerial < 1) {
    return res.status(400).json({ error: 'Valid next_serial is required.' });
  }

  memoryLastSerial = Math.max(memoryLastSerial, nextSerial - 1);
  const sb = supabaseConfig();
  if (sb.enabled) {
    try {
      await axios.patch(
        `${sb.url}/rest/v1/gs1_sscc_counter?id=eq.1`,
        { last_serial: nextSerial - 1, updated_at: new Date().toISOString() },
        { headers: supabaseHeaders({ 'Prefer': 'return=minimal' }), timeout: 5000 }
      );
    } catch (err) {
      console.warn('[Supabase Set Serial Warning]', err.response?.data || err.message);
    }
  }
  return res.json({ success: true, next_serial: nextSerial });
});

// ─── POST /api/order-state ───────────────────────────────────────────────────
// Saves/upserts the active order's pallets, assigned quantities, SSCCs, and customizer edits
app.post('/api/order-state', requireAuth, async (req, res) => {
  try {
    const { order_id, sale_order, pallets, active_pallet_index } = req.body || {};
    if (!order_id && !sale_order) {
      return res.status(400).json({ error: 'order_id or sale_order is required.' });
    }
    const result = await saveOrderStateToDb(order_id, sale_order, pallets, active_pallet_index);
    return res.json(result);
  } catch (err) {
    console.error('[Save Order State Error]', err.message);
    return res.status(500).json({ error: 'Failed to save order state.', detail: err.message });
  }
});

// ─── POST /api/barcode ───────────────────────────────────────────────────────
// Server-side barcode rendering — returns a PNG buffer
app.post('/api/barcode', requireAuth, async (req, res) => {
  const { text, type = 'code128', scale = 2, height = 15 } = req.body;

  if (!text) return res.status(400).json({ error: 'text is required.' });

  try {
    const png = await bwipjs.toBuffer({
      bcid: type,
      text: String(text),
      scale,
      height,
      includetext: false,
      backgroundcolor: 'ffffff',
    });

    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    console.error('[Barcode Error]', err.message);
    res.status(500).json({ error: 'Barcode generation failed.', detail: err.message });
  }
});

// ─── GET /api/config ─────────────────────────────────────────────────────────
app.get('/api/config', requireAuth, async (req, res) => {
  const apiKey = (process.env.ODOO_API_KEY || '').replace(/^"|"$/g, '').trim();
  const db = (process.env.ODOO_DB || '').trim();
  const url = (process.env.ODOO_URL || '').replace(/\/+$/, '');
  const sb = supabaseConfig();

  let currentNextSerial = Math.max(memoryLastSerial + 1, parseInt(process.env.SSCC_START_SERIAL || '1000', 10));
  if (sb.enabled) {
    try {
      const counterResp = await axios.get(
        `${sb.url}/rest/v1/gs1_sscc_counter?id=eq.1&select=last_serial`,
        { headers: supabaseHeaders(), timeout: 5000 }
      );
      if (Array.isArray(counterResp.data) && counterResp.data[0]?.last_serial != null) {
        const dbLast = Number(counterResp.data[0].last_serial);
        if (Number.isFinite(dbLast)) {
          memoryLastSerial = Math.max(memoryLastSerial, dbLast);
          currentNextSerial = Math.max(currentNextSerial, dbLast + 1);
        }
      }
    } catch (_) {
      // Ignore if table not created yet
    }
  }

  res.json({
    odoo_url: url,
    odoo_db: db || '(not set)',
    gs1_company_prefix: process.env.GS1_COMPANY_PREFIX || '26249798',
    sscc_start_serial: currentNextSerial,
    extension_digit: process.env.SSCC_EXTENSION_DIGIT || '3',
    api_key_set: !!apiKey,
    auth_ready: !!(apiKey && db && url),
    supabase_enabled: sb.enabled,
  });
});

// ─── Catch-all: serve index.html ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  GS1 Label Printer running at http://localhost:${PORT}`);
  console.log(`    Odoo Target : ${process.env.ODOO_URL || '(not configured)'}`);
  console.log(`    Database    : ${process.env.ODOO_DB || '(not configured)'}`);
  console.log(`    GS1 Prefix  : ${process.env.GS1_COMPANY_PREFIX || '(not configured)'}\n`);
});

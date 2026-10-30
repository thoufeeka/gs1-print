require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bwipjs = require('bwip-js');
const path = require('path');

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

// ─── Simple Application Authentication ───────────────────────────────────────
const validTokens = new Set();

const getAppCredentials = () => ({
  username: (process.env.APP_USERNAME || 'admin').trim(),
  password: (process.env.APP_PASSWORD || 'admin').trim(),
});

// POST /api/login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const creds = getAppCredentials();

  if (username && password && String(username).trim() === creds.username && String(password).trim() === creds.password) {
    const token = 'gs1_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    validTokens.add(token);
    return res.json({ success: true, token, username: creds.username });
  }
  return res.status(401).json({ success: false, error: 'Invalid username or password.' });
});

// GET /api/auth-check
app.get('/api/auth-check', (req, res) => {
  const token = (req.headers['x-auth-token'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (token && validTokens.has(token)) {
    return res.json({ authenticated: true, username: getAppCredentials().username });
  }
  return res.status(401).json({ authenticated: false });
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  const token = (req.headers['x-auth-token'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (token) validTokens.delete(token);
  return res.json({ success: true });
});

// Middleware for protected routes
const requireAuth = (req, res, next) => {
  const token = (req.headers['x-auth-token'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (token && validTokens.has(token)) {
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
        move_id:      move.id,
        picking_id:   move.picking_id?.[0],
        picking_name: move.picking_id?.[1],
        product_id:   move.product_id?.[0],
        product_name: product.name || move.product_id?.[1] || move.description_picking || 'Product',
        product_ref:  product.default_code || '',
        barcode:      product.barcode || '',
        qty_demand:   move.product_uom_qty || 0,
        qty_done:     move.quantity || 0,
        uom:          move.product_uom?.[1] || 'Units',
        state:        move.state,
        lots:         lots.join(', '),
        description:  move.description_picking || '',
      };
    });

    return res.json({
      order_id: trimmedId,
      sale_order: saleOrder ? saleOrder.name : (pickings[0]?.origin || trimmedId),
      client_order_ref: saleOrder?.client_order_ref || '',
      partner: partnerInfo,
      pickings: pickings.map(p => ({
        id:           p.id,
        name:         p.name,
        origin:       p.origin,
        state:        p.state,
        partner:      p.partner_id?.[1] || '',
        picking_type: p.picking_type_id?.[1] || '',
        date:         p.date_done || p.scheduled_date || '',
      })),
      move_lines: enrichedMoves,
      config: {
        gs1_company_prefix: process.env.GS1_COMPANY_PREFIX || '26249798',
        sscc_start_serial:  parseInt(process.env.SSCC_START_SERIAL || '1000', 10),
        extension_digit:    process.env.SSCC_EXTENSION_DIGIT || '3',
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
app.get('/api/config', requireAuth, (req, res) => {
  const apiKey   = (process.env.ODOO_API_KEY || '').replace(/^"|"$/g, '').trim();
  const db       = (process.env.ODOO_DB || '').trim();
  const url      = (process.env.ODOO_URL || '').replace(/\/+$/, '');
  res.json({
    odoo_url:           url,
    odoo_db:            db || '(not set)',
    gs1_company_prefix: process.env.GS1_COMPANY_PREFIX || '26249798',
    sscc_start_serial:  parseInt(process.env.SSCC_START_SERIAL || '1000', 10),
    extension_digit:    process.env.SSCC_EXTENSION_DIGIT || '3',
    api_key_set:        !!apiKey,
    auth_ready:         !!(apiKey && db && url),
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

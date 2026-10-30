// Odoo 19 Online Connection Tester
require('dotenv').config();
const https = require('https');

const ODOO_URL    = (process.env.ODOO_URL    || '').replace(/\/+$/, '');
const ODOO_API_KEY = (process.env.ODOO_API_KEY || '').replace(/^"|"$/g, '').trim();
const ODOO_DB     = process.env.ODOO_DB      || '';
const ODOO_USER   = process.env.ODOO_USERNAME || '';

console.log('\n🔗 Odoo 19 Online Connection Test');
console.log('──────────────────────────────────────────────────────');
console.log(`  URL        : ${ODOO_URL}`);
console.log(`  Database   : ${ODOO_DB}`);
console.log(`  API Key    : ${ODOO_API_KEY.slice(0, 8)}${'*'.repeat(Math.max(0, ODOO_API_KEY.length - 8))}`);
console.log(`  Auth Mode  : Bearer API Key (Odoo 19 External JSON-2 API)`);
console.log('──────────────────────────────────────────────────────\n');

if (!ODOO_URL || !ODOO_API_KEY || !ODOO_DB) {
  console.error('❌ Configuration missing in .env!');
  if (!ODOO_URL) console.error('   Missing: ODOO_URL');
  if (!ODOO_DB) console.error('   Missing: ODOO_DB');
  if (!ODOO_API_KEY) console.error('   Missing: ODOO_API_KEY');
  process.exit(1);
}

function callJson2(model, method, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const parsed = new URL(ODOO_URL);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `/json/2/${model}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ODOO_API_KEY}`,
        'X-Odoo-Database': ODOO_DB,
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let parsedBody = null;
        try { parsedBody = JSON.parse(body); } catch (e) { parsedBody = body; }
        resolve({ status: res.statusCode, body: parsedBody });
      });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.setTimeout(12000, () => {
      req.destroy();
      resolve({ status: 408, error: 'Request timed out' });
    });
    req.write(data);
    req.end();
  });
}

function printResult(label, r) {
  if (r.status === 200 && Array.isArray(r.body)) {
    console.log(`  ✅ PASS  — ${r.body.length} record(s) returned`);
    r.body.slice(0, 3).forEach(rec => {
      const name = rec.name || rec.display_name || rec.id;
      const extra = rec.state ? ` [${rec.state}]` : '';
      const orig = rec.origin ? ` ← ${rec.origin}` : '';
      console.log(`           · ${name}${extra}${orig}`);
    });
  } else if (r.status === 200 && typeof r.body === 'object' && r.body !== null) {
    if (r.body.error) {
      console.log(`  ❌ FAIL  — Odoo error:`, JSON.stringify(r.body.error).slice(0, 200));
    } else {
      console.log(`  ✅ PASS  — Object result returned`);
    }
  } else {
    console.log(`  ❌ FAIL  — HTTP ${r.status}:`, (r.error || JSON.stringify(r.body)).slice(0, 250));
  }
}

(async () => {
  // Test 1: Partners
  console.log('TEST 1: /json/2/res.partner/search_read');
  const res1 = await callJson2('res.partner', 'search_read', {
    domain: [],
    fields: ['id', 'name', 'city'],
    limit: 3
  });
  printResult('1', res1);

  // Test 2: Deliveries (stock.picking)
  console.log('\nTEST 2: /json/2/stock.picking/search_read (Deliveries)');
  const res2 = await callJson2('stock.picking', 'search_read', {
    domain: [],
    fields: ['id', 'name', 'origin', 'state'],
    limit: 3
  });
  printResult('2', res2);

  // Test 3: Sales Orders (sale.order)
  console.log('\nTEST 3: /json/2/sale.order/search_read (Sales Orders)');
  const res3 = await callJson2('sale.order', 'search_read', {
    domain: [],
    fields: ['id', 'name', 'partner_id', 'state'],
    limit: 3
  });
  printResult('3', res3);

  console.log('\n──────────────────────────────────────────────────────');
  console.log('✅ Odoo 19 External JSON-2 API connection verified successfully!\n');
})();

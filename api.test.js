'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { createApp } = require('../src/app');

function png() { // minimal valid 1x1 PNG
  const crc = b => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const ch = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), ch('IHDR', ihdr), ch('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), ch('IEND', Buffer.alloc(0))]).toString('base64');
}
const SHOT = png();
const ADDR = { name: 'Anita Rao', mobile: '9876543210', address: '12 MG Road, Hyderabad', city: 'Hyderabad', pin: '500001' };

let app, base;
test.before(async () => {
  app = createApp({ DB_PATH: ':memory:', UPLOAD_DIR: require('node:os').tmpdir() + '/qm-test-' + process.pid, ADMIN_EMAIL: 'admin@test.io', ADMIN_PASSWORD: 'a-long-admin-password', NODE_ENV: 'test' });
  await new Promise(r => app.server.listen(0, r)); base = 'http://127.0.0.1:' + app.server.address().port;
});
test.after(() => app.close());

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const owner = client(), buyer = client(), buyer2 = client(), admin = client(), anon = client();
let rice, shampoo;
const orders = () => app.db.prepare('SELECT COUNT(*) n FROM orders').get().n;
const stock = id => app.db.prepare('SELECT stock FROM products WHERE id=?').get(id).stock;

test('registration, login, session, logout, bad credentials', async () => {
  assert.equal((await owner('POST', '/api/auth/register', { email: 'o@t.io', password: 'password123', name: 'Raj', role: 'owner', shop: 'Raj Stores' })).status, 200);
  assert.equal((await buyer('POST', '/api/auth/register', { email: 'b@t.io', password: 'password123', name: 'Anita' })).status, 200);
  assert.equal((await buyer2('POST', '/api/auth/register', { email: 'b2@t.io', password: 'password123', name: 'Bala' })).status, 200);
  assert.equal((await anon('POST', '/api/auth/register', { email: 'o@t.io', password: 'password123', name: 'Dup' })).status, 409);
  assert.equal((await anon('POST', '/api/auth/register', { email: 'x@t.io', password: 'short', name: 'Xx' })).status, 400);
  assert.equal((await anon('POST', '/api/auth/login', { email: 'b@t.io', password: 'wrong-password' })).status, 401);
  assert.equal((await admin('POST', '/api/auth/login', { email: 'admin@test.io', password: 'a-long-admin-password' })).status, 200);
  assert.equal((await buyer('GET', '/api/me')).body.user.role, 'buyer');
  assert.equal((await anon('GET', '/api/me')).status, 401);
  const hash = app.db.prepare("SELECT pass_hash FROM users WHERE email='b@t.io'").get().pass_hash; assert.match(hash, /^s1\$/); assert.ok(!hash.includes('password123'));
});
test('self-registration can never create an admin', async () => {
  const c = client(); await c('POST', '/api/auth/register', { email: 'sneaky@t.io', password: 'password123', name: 'Sneaky', role: 'admin' });
  assert.equal((await c('GET', '/api/me')).body.user.role, 'buyer');
});
test('role permissions are enforced on the server', async () => {
  const p = { name: 'Thing', type: 'other', category: 'Groceries', description: 'A long enough description', price: 10, stock: 5, unit: 'pcs' };
  assert.equal((await buyer('POST', '/api/products', p)).status, 403);
  assert.equal((await anon('POST', '/api/products', p)).status, 401);
  assert.equal((await buyer('GET', '/api/admin/payments')).status, 403);
  assert.equal((await owner('GET', '/api/admin/payments')).status, 403);
});
test('owner creates loose and packaged products (validated)', async () => {
  const base = { category: 'Groceries', description: 'Good quality product', image: SHOT };
  assert.equal((await owner('POST', '/api/products', { ...base, name: 'Rice', type: 'loose', unit: 'kg', price: 200, stock: 50 })).status, 200);
  assert.equal((await owner('POST', '/api/products', { ...base, name: 'Shampoo', type: 'packaged', unit: 'bottle', packageSize: 200, packageUnit: 'ml', price: 80, stock: 25 })).status, 200);
  assert.equal((await owner('POST', '/api/products', { ...base, name: 'Bad', type: 'loose', unit: 'bottle', price: 5, stock: 5 })).status, 400);
  assert.equal((await owner('POST', '/api/products', { ...base, name: 'Bad', type: 'packaged', unit: 'bottle', price: 5, stock: 5 })).status, 400);
  assert.equal((await owner('POST', '/api/products', { ...base, name: 'BadImg', type: 'other', unit: 'pcs', price: 5, stock: 5, image: 'data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })).status, 400);
  const list = (await anon('GET', '/api/products')).body.products;
  rice = list.find(p => p.name === 'Rice').id; shampoo = list.find(p => p.name === 'Shampoo').id;
  assert.equal(list.find(p => p.id === rice).available, '50 kg'); assert.equal(list.find(p => p.id === shampoo).packageSize, '200 ml');
});
test('prices are computed on the server: 500 g of ₹200/kg = ₹100', async () => {
  const q = async (qty, unit) => (await buyer('POST', '/api/quote', { items: [{ productId: rice, qty, unit }] }));
  const t = async (qty, unit) => (await q(qty, unit)).body.groups[0].lines[0].lineTotal;
  assert.equal(await t(500, 'g'), 100); assert.equal(await t(250, 'g'), 50); assert.equal(await t(1, 'kg'), 200); assert.equal(await t(2, 'kg'), 400);
  assert.equal((await buyer('POST', '/api/quote', { items: [{ productId: shampoo, qty: 3 }] })).body.groups[0].lines[0].lineTotal, 240);
  assert.equal((await buyer('POST', '/api/quote', { items: [{ productId: shampoo, qty: 3, price: 1, total: 1 }] })).body.total, 289); // 240 + 49 delivery; client price ignored
  for (const [qty, unit] of [[0, 'kg'], [-1, 'kg'], [51, 'kg'], [0.0005, 'kg'], [500, 'm'], ['5', 'kg']]) assert.ok((await q(qty, unit)).status >= 400, `${qty}${unit}`);
  assert.ok((await buyer('POST', '/api/quote', { items: [{ productId: shampoo, qty: 26 }] })).status === 409);
  assert.ok((await buyer('POST', '/api/quote', { items: [{ productId: shampoo, qty: 1.5 }] })).status === 400);
});
test('abandoned online payment creates NO order and holds no stock', async () => {
  const before = orders(), s0 = stock(shampoo);
  const s = await buyer('POST', '/api/payments/sessions', { items: [{ productId: shampoo, qty: 2 }], address: ADDR });
  assert.equal(s.status, 200); assert.equal(s.body.amount, 209);
  assert.equal((await buyer('DELETE', '/api/payments/sessions/' + s.body.sessionId)).body.discarded, true);   // Back to Order
  assert.equal(orders(), before); assert.equal(stock(shampoo), s0);
  assert.equal((await buyer('GET', '/api/orders')).body.orders.length, 0);
  assert.equal((await owner('GET', '/api/orders')).body.orders.length, 0);
  const late = await buyer('POST', `/api/payments/sessions/${s.body.sessionId}/proof`, { utr: 'UTR12345678', screenshot: SHOT });
  assert.equal(late.status, 410); assert.equal(orders(), before);
});
test('proof validation: missing/invalid UTR or screenshot creates nothing', async () => {
  const s = (await buyer('POST', '/api/payments/sessions', { items: [{ productId: shampoo, qty: 1 }], address: ADDR })).body.sessionId, before = orders();
  const post = b => buyer('POST', `/api/payments/sessions/${s}/proof`, b);
  assert.equal((await post({ screenshot: SHOT })).status, 400);
  assert.equal((await post({ utr: 'ab', screenshot: SHOT })).status, 400);
  assert.equal((await post({ utr: 'UTR12345678' })).status, 400);
  assert.equal((await post({ utr: 'UTR12345678', screenshot: 'photo.png' })).status, 400);
  assert.equal((await post({ utr: 'UTR12345678', screenshot: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })).status, 400);
  assert.equal(orders(), before);
  assert.equal((await buyer2('POST', `/api/payments/sessions/${s}/proof`, { utr: 'UTR12345678', screenshot: SHOT })).status, 404); // another buyer's session
});
test('valid proof makes ONE verification_pending order; duplicates and reused UTRs are rejected', async () => {
  const s0 = stock(shampoo), sid = (await buyer('POST', '/api/payments/sessions', { items: [{ productId: shampoo, qty: 2 }, { productId: rice, qty: 500, unit: 'g' }], address: ADDR })).body.sessionId;
  const r = await buyer('POST', `/api/payments/sessions/${sid}/proof`, { utr: 'UTRABC123456', screenshot: SHOT });
  assert.equal(r.status, 200); assert.equal(r.body.orderIds.length, 1); assert.equal(r.body.payStatus, 'verification_pending');
  const o = app.db.prepare('SELECT * FROM orders WHERE id=?').get(r.body.orderIds[0]);
  assert.equal(o.pay_status, 'verification_pending');
  assert.equal(o.total_cents, 16000 + 10000 + 4900);                       // 2×80 + 500 g×200/kg + delivery
  assert.equal(stock(shampoo), s0 - 2);
  const dup = await buyer('POST', `/api/payments/sessions/${sid}/proof`, { utr: 'UTRABC123456', screenshot: SHOT });
  assert.equal(dup.status, 409); assert.equal(app.db.prepare("SELECT COUNT(*) n FROM orders WHERE method='online'").get().n, 1);
  const sid2 = (await buyer('POST', '/api/payments/sessions', { items: [{ productId: shampoo, qty: 1 }], address: ADDR })).body.sessionId;
  assert.equal((await buyer('POST', `/api/payments/sessions/${sid2}/proof`, { utr: 'utrabc123456', screenshot: SHOT })).status, 409); // same UTR, any case
  assert.equal(stock(shampoo), s0 - 2);
  assert.equal((await owner('GET', '/api/orders')).body.orders.length, 1);
});
test('only an admin can mark an online payment as paid', async () => {
  const pay = (await admin('GET', '/api/admin/payments')).body.payments[0];
  assert.equal(pay.status, 'verification_pending');
  assert.equal((await buyer('POST', `/api/admin/payments/${pay.id}/verify`, { approve: true })).status, 403);
  assert.equal(app.db.prepare('SELECT pay_status FROM orders WHERE id=?').get(pay.orderId).pay_status, 'verification_pending');
  assert.equal((await admin('POST', `/api/admin/payments/${pay.id}/verify`, { approve: true })).status, 200);
  assert.equal(app.db.prepare('SELECT pay_status,status FROM orders WHERE id=?').get(pay.orderId).pay_status, 'paid');
  assert.equal((await admin('POST', `/api/admin/payments/${pay.id}/verify`, { approve: false })).status, 409);
  assert.equal((await buyer('GET', pay.screenshot)).status, 403);                        // proofs are admin-only
});
test('COD: needs explicit confirm, ends pending_collection, never paid', async () => {
  const before = orders();
  assert.equal((await buyer('POST', '/api/orders/cod', { items: [{ productId: shampoo, qty: 1 }], address: ADDR })).status, 400);
  assert.equal(orders(), before);
  const r = await buyer('POST', '/api/orders/cod', { items: [{ productId: rice, qty: 250, unit: 'g' }], address: ADDR, confirm: true });
  assert.equal(r.status, 200);
  const o = app.db.prepare('SELECT * FROM orders WHERE id=?').get(r.body.orderIds[0]); assert.equal(o.pay_status, 'pending_collection'); assert.equal(o.total_cents, 5000 + 4900);
});
test('stock cannot be oversold and cancelling returns stock exactly', async () => {
  const start = stock(rice);                                                       // 49,250 g after earlier orders
  const big = await buyer2('POST', '/api/orders/cod', { items: [{ productId: rice, qty: 49, unit: 'kg' }], address: ADDR, confirm: true });
  assert.equal(big.status, 200); assert.equal(stock(rice), start - 49000);
  const left = stock(rice);                                                        // 250 g left
  const over = await buyer('POST', '/api/orders/cod', { items: [{ productId: rice, qty: 300, unit: 'g' }], address: ADDR, confirm: true });
  assert.equal(over.status, 409); assert.equal(stock(rice), left);
  const o = await buyer('POST', '/api/orders/cod', { items: [{ productId: rice, qty: 100, unit: 'g' }], address: ADDR, confirm: true });
  assert.equal(stock(rice), left - 100);
  assert.equal((await buyer2('POST', `/api/orders/${o.body.orderIds[0]}/cancel`)).status, 404);   // not your order
  assert.equal((await buyer('POST', `/api/orders/${o.body.orderIds[0]}/cancel`)).status, 200);
  assert.equal(stock(rice), left);
});
test('login is rate limited', async () => {
  const c = client(); let last; for (let i = 0; i < 14; i++) last = await c('POST', '/api/auth/login', { email: 'nobody@t.io', password: 'x' });
  assert.equal(last.status, 429);
});
test('security headers, JSON-only writes, cross-origin writes blocked', async () => {
  const r = await fetch(base + '/'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.status, 200);
  assert.equal((await fetch(base + '/api/products', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })).status, 403);
});

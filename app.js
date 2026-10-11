'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { open } = require('./db'); const R = require('./rules'); const { Bad } = R;

const CATS = ['Groceries', 'Ayurvedic Medicines', 'Other Medical Products', 'Household Products', 'Other Categories'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function createApp(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const db = open(env.DB_PATH || './data/qm.db');
  const uploadDir = path.resolve(env.UPLOAD_DIR || './uploads'); fs.mkdirSync(uploadDir, { recursive: true });
  const pubDir = path.resolve(__dirname, '..', 'public');
  const RATE = +env.COMMISSION_RATE || 5;
  const now = () => new Date().toISOString();
  const audit = (uid, action, detail) => db.prepare('INSERT INTO audit_log(user_id,action,detail) VALUES(?,?,?)').run(uid ?? null, action, detail ? JSON.stringify(detail) : null);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  // ---- password hashing + sessions ----
  const hashPw = pw => { const s = crypto.randomBytes(16); return 's1$' + s.toString('hex') + '$' + crypto.scryptSync(pw, s, 64).toString('hex'); };
  const checkPw = (pw, h) => { const [v, s, k] = h.split('$'); if (v !== 's1') return false; const a = Buffer.from(k, 'hex'), b = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const th = t => crypto.createHash('sha256').update(t).digest('hex');
  const SESSION_MS = 7 * 864e5;
  const startSession = (res, uid) => {
    const t = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(th(t), uid, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `qm_sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${prod ? '; Secure' : ''}`);
  };
  const userFrom = req => {
    const m = /(?:^|;\s*)qm_sid=([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (!m) return null;
    const row = db.prepare('SELECT u.id,u.email,u.name,u.role,u.shop,u.mobile,u.status,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(th(m[1]));
    if (!row || row.expires_at < Date.now() || row.status !== 'Active') return null; return row;
  };
  // seed admin from env (never hard-coded)
  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 12 && !db.prepare('SELECT 1 FROM users WHERE email=?').get(env.ADMIN_EMAIL))
    db.prepare("INSERT INTO users(email,name,role,pass_hash) VALUES(?,?,?,?)").run(env.ADMIN_EMAIL, 'Admin', 'admin', hashPw(env.ADMIN_PASSWORD));

  // ---- tiny in-memory rate limiter (per IP + bucket) ----
  const hits = new Map();
  const limit = (req, bucket, max, winMs) => {
    const k = bucket + '|' + (req.socket.remoteAddress || ''), t = Date.now(), a = (hits.get(k) || []).filter(x => t - x < winMs);
    a.push(t); hits.set(k, a); if (a.length > max) throw new Bad('Too many attempts. Try again later.', 429);
  };

  // ---- validation helpers ----
  const str = (v, min, max, label) => { if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new Bad(`${label} must be ${min}-${max} characters`); return v.trim(); };
  const emailOk = e => typeof e === 'string' && e.length <= 254 && /^\S+@\S+\.\S+$/.test(e);
  const need = (u, ...roles) => { if (!u) throw new Bad('Please log in', 401); if (!roles.includes(u.role)) throw new Bad('Not allowed', 403); return u; };
  const money = c => c / 100;

  function saveImage(dataUrl, label) {
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) throw new Bad(`${label}: upload a PNG, JPG or WEBP image`);
    const buf = Buffer.from(m[2], 'base64'); if (buf.length > 2e6 || buf.length < 20) throw new Bad(`${label}: image must be under 2 MB`);
    const magic = m[1] === 'png' ? buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) : m[1] === 'jpeg' ? buf[0] === 0xff && buf[1] === 0xd8 : buf.subarray(0, 4).toString() === 'RIFF';
    if (!magic) throw new Bad(`${label}: file content does not match its type`);
    const name = crypto.randomBytes(16).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFileSync(path.join(uploadDir, name), buf); return name;
  }

  // ---- pricing from the DATABASE (client totals are never trusted) ----
  function priceCart(items, { lock = false } = {}) {
    if (!Array.isArray(items) || !items.length || items.length > 50) throw new Bad('Cart is empty or too large');
    const groups = new Map();
    for (const it of items) {
      const p = db.prepare('SELECT p.*,u.status ostatus FROM products p JOIN users u ON u.id=p.owner_id WHERE p.id=?').get(+it.productId);
      if (!p || p.status !== 'Active' || p.ostatus !== 'Active') throw new Bad('A product in your cart is no longer available', 409);
      const stored = R.toStored(p, it.qty, it.unit);
      if (stored > p.stock) throw new Bad(`${p.name}: only ${R.stockText(p, p.stock)} available`, 409);
      const g = groups.get(p.owner_id) || { owner_id: p.owner_id, lines: [] }; groups.set(p.owner_id, g);
      const ex = g.lines.find(l => l.p.id === p.id);
      if (ex) { ex.stored += stored; if (ex.stored > p.stock) throw new Bad(`${p.name}: only ${R.stockText(p, p.stock)} available`, 409); }
      else g.lines.push({ p, stored });
    }
    const out = [...groups.values()].map(g => {
      g.lines.forEach(l => { l.unit_price = R.unitCents(l.p); l.line = R.lineCents(l.p, l.stored); });
      const sub = g.lines.reduce((s, l) => s + l.line, 0), del = R.deliveryCents(sub);
      return { ...g, sub, del, total: sub + del };
    });
    return { groups: out, amount: out.reduce((s, g) => s + g.total, 0) };
  }
  const cleanAddr = a => ({ name: str(a?.name, 2, 80, 'Name'), mobile: /^\d{10}$/.test(a?.mobile) ? a.mobile : (() => { throw new Bad('Mobile must be 10 digits'); })(), address: str(a?.address, 8, 300, 'Address'), city: str(a?.city, 2, 80, 'City'), pin: /^\d{6}$/.test(a?.pin) ? a.pin : (() => { throw new Bad('PIN must be 6 digits'); })() });

  // creates orders + reserves stock inside the caller's transaction
  function createOrders(buyerId, priced, address, method, payStatus, status) {
    const ids = [];
    for (const g of priced.groups) {
      const o = db.prepare('INSERT INTO orders(buyer_id,owner_id,method,status,pay_status,subtotal_cents,delivery_cents,total_cents,address) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(buyerId, g.owner_id, method, status, payStatus, g.sub, g.del, g.total, JSON.stringify(address));
      const oid = Number(o.lastInsertRowid); ids.push(oid);
      for (const l of g.lines) {
        const r = db.prepare('UPDATE products SET stock=stock-?,updated_at=? WHERE id=? AND stock>=?').run(l.stored, now(), l.p.id, l.stored);
        if (r.changes !== 1) throw new Bad(`${l.p.name} just sold out`, 409);   // blocks double-selling
        db.prepare('INSERT INTO order_items(order_id,product_id,name,ptype,unit,qty,unit_price_cents,line_cents) VALUES(?,?,?,?,?,?,?,?)').run(oid, l.p.id, l.p.name, l.p.ptype, l.p.unit, l.stored, l.unit_price, l.line);
      }
    }
    return ids;
  }
  const orderView = o => ({
    id: o.id, method: o.method, status: o.status, payStatus: o.pay_status, subtotal: money(o.subtotal_cents), delivery: money(o.delivery_cents), total: money(o.total_cents),
    address: JSON.parse(o.address), createdAt: o.created_at, buyerId: o.buyer_id, ownerId: o.owner_id,
    items: db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id).map(i => ({ productId: i.product_id, name: i.name, type: i.ptype, unit: i.unit, quantity: R.stockText(i, i.qty), unitPrice: money(i.unit_price_cents), lineTotal: money(i.line_cents) }))
  });
  const productView = (p, showStock = true) => ({ id: p.id, ownerId: p.owner_id, name: p.name, category: p.category, description: p.description, image: p.image && '/uploads/' + p.image, type: p.ptype, unit: p.unit, packageSize: p.pkg_size ? `${p.pkg_size} ${p.pkg_unit}` : null, packageSizeValue: p.pkg_size, packageUnit: p.pkg_unit, price: money(p.price_cents), discountPct: p.discount_pct, stock: p.stock, available: R.stockText(p, p.stock), status: p.status, shop: p.shop });

  // ================= routes =================
  const routes = [];
  const route = (m, re, fn) => routes.push([m, new RegExp('^' + re + '$'), fn]);

  route('POST', '/api/auth/register', ({ req, res, body }) => {
    limit(req, 'auth', 10, 6e5);
    const email = emailOk(body.email) ? body.email.trim() : (() => { throw new Bad('Enter a valid email'); })();
    const pw = typeof body.password === 'string' && body.password.length >= 8 && body.password.length <= 200 ? body.password : (() => { throw new Bad('Password must be at least 8 characters'); })();
    const role = body.role === 'owner' ? 'owner' : 'buyer'; // admin is never self-registered
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new Bad('That email is already registered', 409);
    const r = db.prepare('INSERT INTO users(email,name,role,shop,mobile,pass_hash) VALUES(?,?,?,?,?,?)').run(email, str(body.name, 2, 80, 'Name'), role, role === 'owner' ? str(body.shop, 2, 80, 'Shop name') : null, body.mobile && /^\d{10}$/.test(body.mobile) ? body.mobile : null, hashPw(pw));
    startSession(res, Number(r.lastInsertRowid)); audit(Number(r.lastInsertRowid), 'register');
    return { ok: true, user: db.prepare('SELECT id,email,name,role,shop FROM users WHERE id=?').get(r.lastInsertRowid) };
  });
  route('POST', '/api/auth/login', ({ req, res, body }) => {
    limit(req, 'auth', 10, 6e5);
    const u = typeof body.email === 'string' ? db.prepare('SELECT * FROM users WHERE email=?').get(body.email) : null;
    const ok = u && typeof body.password === 'string' && checkPw(body.password, u.pass_hash);
    if (!ok || u.status !== 'Active') throw new Bad('Email or password is incorrect', 401);
    startSession(res, u.id); audit(u.id, 'login');
    return { ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role, shop: u.shop } };
  });
  route('POST', '/api/auth/logout', ({ req, res }) => {
    const m = /qm_sid=([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (m) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(th(m[1]));
    res.setHeader('Set-Cookie', 'qm_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return { ok: true };
  });
  route('GET', '/api/me', ({ user }) => ({ user: need(user, 'buyer', 'owner', 'admin') }));

  // ---- products ----
  route('GET', '/api/products', ({ url }) => {
    const q = '%' + (url.searchParams.get('q') || '').replace(/[%_]/g, '') + '%', cat = url.searchParams.get('category');
    const rows = db.prepare("SELECT p.*,u.shop FROM products p JOIN users u ON u.id=p.owner_id WHERE p.status='Active' AND p.stock>0 AND u.status='Active' AND (p.name LIKE ? OR p.description LIKE ?) AND (? IS NULL OR p.category=?) ORDER BY p.created_at DESC LIMIT 200").all(q, q, cat, cat);
    return { products: rows.map(p => productView(p)) };
  });
  route('GET', '/api/my/products', ({ user }) => { need(user, 'owner'); return { products: db.prepare('SELECT p.*,? shop FROM products p WHERE owner_id=? ORDER BY id DESC').all(user.shop, user.id).map(p => productView(p)) }; });
  route('POST', '/api/products', ({ user, body }) => {
    need(user, 'owner');
    const ptype = ['packaged', 'loose', 'other'].includes(body.type) ? body.type : (() => { throw new Bad('Choose a product type'); })();
    const cat = CATS.includes(body.category) ? body.category : (() => { throw new Bad('Choose a valid category'); })();
    const price = Math.round(+body.price * 100); if (!(price > 0) || price > 1e9) throw new Bad('Enter a valid price');
    const unit = str(body.unit, 1, 12, 'Unit'); let stock, pkgSize = null, pkgUnit = null;
    if (ptype === 'loose') {
      if (!R.UF[unit]) throw new Bad('Loose products must use kg, g, L or ml');
      const q = +body.stock; if (!(q >= 0)) throw new Bad('Enter the available quantity');
      stock = Math.round(q * R.UF[unit].f); if (Math.abs(q * R.UF[unit].f - stock) > 1e-6) throw new Bad('Quantity is too precise');
    } else {
      if (!Number.isInteger(+body.stock) || +body.stock < 0) throw new Bad('Stock must be a whole number'); stock = +body.stock;
      if (ptype === 'packaged') { pkgSize = +body.packageSize; pkgUnit = ['ml', 'L', 'g', 'kg', 'pcs'].includes(body.packageUnit) ? body.packageUnit : null; if (!(pkgSize > 0) || !pkgUnit) throw new Bad('Enter the package size and unit'); }
    }
    const disc = +body.discountPct || 0; if (disc < 0 || disc > 90) throw new Bad('Discount must be 0–90%');
    const img = body.image ? saveImage(body.image, 'Product image') : null;
    const r = db.prepare('INSERT INTO products(owner_id,name,category,description,image,ptype,unit,pkg_size,pkg_unit,price_cents,stock,discount_pct) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(user.id, str(body.name, 2, 120, 'Name'), cat, str(body.description, 10, 2000, 'Description'), img, ptype, unit, pkgSize, pkgUnit, price, stock, disc);
    audit(user.id, 'product.create', { id: Number(r.lastInsertRowid) });
    return { ok: true, id: Number(r.lastInsertRowid) };
  });
  route('PATCH', '/api/products/(\\d+)', ({ user, body, m }) => {
    need(user, 'owner'); const p = db.prepare('SELECT * FROM products WHERE id=? AND owner_id=?').get(+m[1], user.id); if (!p) throw new Bad('Product not found', 404);
    const price = body.price !== undefined ? Math.round(+body.price * 100) : p.price_cents; if (!(price > 0)) throw new Bad('Enter a valid price');
    let stock = p.stock; if (body.stock !== undefined) { const f = p.ptype === 'loose' ? R.UF[p.unit].f : 1, s = Math.round(+body.stock * f); if (!(+body.stock >= 0) || (p.ptype !== 'loose' && !Number.isInteger(+body.stock))) throw new Bad('Invalid stock'); stock = s; }
    const status = body.status === undefined ? p.status : ['Active', 'Disabled'].includes(body.status) ? body.status : (() => { throw new Bad('Invalid status'); })();
    db.prepare('UPDATE products SET price_cents=?,stock=?,status=?,updated_at=? WHERE id=?').run(price, stock, status, now(), p.id); audit(user.id, 'product.update', { id: p.id });
    return { ok: true };
  });

  // ---- cart quote (server computed) ----
  route('POST', '/api/quote', ({ user, body }) => {
    need(user, 'buyer'); const c = priceCart(body.items);
    return { total: money(c.amount), groups: c.groups.map(g => ({ ownerId: g.owner_id, subtotal: money(g.sub), delivery: money(g.del), total: money(g.total), lines: g.lines.map(l => ({ productId: l.p.id, name: l.p.name, quantity: R.stockText(l.p, l.stored), unitPrice: money(l.unit_price), lineTotal: money(l.line) })) })) };
  });

  // ---- Cash on delivery: order only on explicit confirm ----
  route('POST', '/api/orders/cod', ({ user, body }) => {
    need(user, 'buyer'); if (body.confirm !== true) throw new Bad('Please confirm the order');
    const addr = cleanAddr(body.address);
    const ids = tx(() => createOrders(user.id, priceCart(body.items), addr, 'cod', 'pending_collection', 'Placed'));
    audit(user.id, 'order.cod', { ids }); return { ok: true, orderIds: ids };
  });

  // ---- Online payment: session (not an order) -> proof -> order in verification_pending ----
  route('POST', '/api/payments/sessions', ({ user, body }) => {
    need(user, 'buyer'); const addr = cleanAddr(body.address), c = priceCart(body.items);
    const r = db.prepare('INSERT INTO payment_sessions(buyer_id,items,address,amount_cents,expires_at) VALUES(?,?,?,?,?)').run(user.id, JSON.stringify(body.items), JSON.stringify(addr), c.amount, Date.now() + 30 * 6e4);
    return { sessionId: Number(r.lastInsertRowid), amount: money(c.amount), note: 'No order exists until valid payment proof is submitted.' };
  });
  route('DELETE', '/api/payments/sessions/(\\d+)', ({ user, m }) => { // "Back to Order"
    need(user, 'buyer'); const r = db.prepare("UPDATE payment_sessions SET status='abandoned' WHERE id=? AND buyer_id=? AND status='open'").run(+m[1], user.id);
    return { ok: true, discarded: r.changes === 1 };
  });
  route('POST', '/api/payments/sessions/(\\d+)/proof', ({ user, body, m }) => {
    need(user, 'buyer'); const utr = typeof body.utr === 'string' && /^[A-Za-z0-9]{8,22}$/.test(body.utr.trim()) ? body.utr.trim() : (() => { throw new Bad('Enter the 8–22 character UTR / transaction reference'); })();
    const shot = saveImage(body.screenshot, 'Payment screenshot');   // real bytes validated, not just a filename
    try {
      const ids = tx(() => {
        const s = db.prepare("SELECT * FROM payment_sessions WHERE id=? AND buyer_id=?").get(+m[1], user.id);
        if (!s) throw new Bad('Payment session not found', 404);
        if (s.status === 'completed') throw new Bad('Proof already submitted for this payment', 409);   // no duplicate orders
        if (s.status !== 'open' || s.expires_at < Date.now()) throw new Bad('This payment session has expired. Start again.', 410);
        const c = priceCart(JSON.parse(s.items));
        if (c.amount !== s.amount_cents) throw new Bad(`The amount changed to ₹${money(c.amount)}. Start the payment again.`, 409);
        const ids = createOrders(user.id, c, JSON.parse(s.address), 'online', 'verification_pending', 'Awaiting Payment');
        for (const id of ids) {
          const o = db.prepare('SELECT total_cents FROM orders WHERE id=?').get(id);
          db.prepare('INSERT INTO payment_proofs(order_id,buyer_id,utr,screenshot,amount_cents) VALUES(?,?,?,?,?)').run(id, user.id, utr, shot, o.total_cents);
        }
        db.prepare("UPDATE payment_sessions SET status='completed' WHERE id=?").run(s.id); return ids;
      });
      audit(user.id, 'payment.proof', { ids }); return { ok: true, orderIds: ids, payStatus: 'verification_pending', note: 'Awaiting verification. Not marked paid yet.' };
    } catch (e) {
      try { fs.unlinkSync(path.join(uploadDir, shot)); } catch { }
      if (/UNIQUE/.test(e.message || '')) throw new Bad('This UTR was already submitted', 409);
      throw e;
    }
  });

  // ---- orders ----
  route('GET', '/api/orders', ({ user }) => {
    need(user, 'buyer', 'owner', 'admin');
    const col = user.role === 'buyer' ? 'buyer_id' : user.role === 'owner' ? 'owner_id' : null;
    const rows = col ? db.prepare(`SELECT * FROM orders WHERE ${col}=? ORDER BY id DESC LIMIT 200`).all(user.id) : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 500').all();
    return { orders: rows.map(orderView) };
  });
  route('POST', '/api/orders/(\\d+)/cancel', ({ user, m }) => {
    need(user, 'buyer');
    tx(() => {
      const o = db.prepare('SELECT * FROM orders WHERE id=? AND buyer_id=?').get(+m[1], user.id); if (!o) throw new Bad('Order not found', 404);
      if (!['Awaiting Payment', 'Placed'].includes(o.status)) throw new Bad('This order can no longer be cancelled', 409);
      for (const i of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id)) db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(i.qty, i.product_id);
      db.prepare("UPDATE orders SET status='Cancelled',cancelled_at=? WHERE id=?").run(now(), o.id);
      db.prepare("UPDATE payment_proofs SET status='rejected',verified_at=? WHERE order_id=? AND status='verification_pending'").run(now(), o.id);
    }); return { ok: true };
  });
  route('POST', '/api/orders/(\\d+)/received', ({ user, m }) => { // buyer confirms collection
    need(user, 'buyer'); const o = db.prepare('SELECT * FROM orders WHERE id=? AND buyer_id=?').get(+m[1], user.id); if (!o) throw new Bad('Order not found', 404);
    if (o.status !== 'Placed') throw new Bad('Order is not ready to be received', 409);
    db.prepare("UPDATE orders SET status='Delivered',delivered_at=? WHERE id=?").run(now(), o.id); return { ok: true };
  });
  route('POST', '/api/orders/(\\d+)/cash-paid', ({ user, m }) => {
    need(user, 'buyer'); const o = db.prepare("SELECT * FROM orders WHERE id=? AND buyer_id=? AND method='cod'").get(+m[1], user.id); if (!o) throw new Bad('Order not found', 404);
    if (o.status !== 'Delivered') throw new Bad('Available after delivery', 409);
    db.prepare("UPDATE orders SET pay_status='paid' WHERE id=?").run(o.id); return { ok: true };
  });

  // ---- admin: payment verification (the ONLY path to paid for online orders) ----
  route('GET', '/api/admin/payments', ({ user }) => {
    need(user, 'admin');
    return { payments: db.prepare('SELECT p.id,p.order_id orderId,p.utr,p.screenshot,p.amount_cents,p.status,p.submitted_at submittedAt,u.email buyer FROM payment_proofs p JOIN users u ON u.id=p.buyer_id ORDER BY p.id DESC LIMIT 500').all().map(x => ({ ...x, amount: money(x.amount_cents), screenshot: '/api/admin/proofs/' + x.screenshot })) };
  });
  route('GET', '/api/admin/proofs/([a-f0-9]{32}\\.(?:png|jpg|webp))', ({ user, m, res }) => {
    need(user, 'admin'); const f = path.join(uploadDir, m[1]); if (!fs.existsSync(f)) throw new Bad('Not found', 404);
    res.writeHead(200, { 'Content-Type': MIME['.' + m[1].split('.')[1]], 'Cache-Control': 'private, no-store' }); fs.createReadStream(f).pipe(res); return undefined;
  });
  route('POST', '/api/admin/payments/(\\d+)/verify', ({ user, body, m }) => {
    need(user, 'admin'); const approve = body.approve === true;
    tx(() => {
      const p = db.prepare('SELECT * FROM payment_proofs WHERE id=?').get(+m[1]); if (!p) throw new Bad('Not found', 404);
      if (p.status !== 'verification_pending') throw new Bad('Already processed', 409);
      db.prepare('UPDATE payment_proofs SET status=?,verified_by=?,verified_at=? WHERE id=?').run(approve ? 'paid' : 'rejected', user.id, now(), p.id);
      if (approve) db.prepare("UPDATE orders SET pay_status='paid',status='Placed' WHERE id=?").run(p.order_id);
      else db.prepare("UPDATE orders SET pay_status='failed' WHERE id=?").run(p.order_id);
    }); audit(user.id, 'payment.verify', { id: +m[1], approve }); return { ok: true };
  });

  // ================= HTTP =================
  const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin', ...(prod ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}) };
  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); };
  function readBody(req) {
    return new Promise((ok, no) => {
      let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > 6e6) { no(new Bad('Request too large', 413)); req.destroy(); } else c.push(d); });
      req.on('end', () => { if (!c.length) return ok({}); try { const j = JSON.parse(Buffer.concat(c).toString()); ok(j && typeof j === 'object' ? j : {}); } catch { no(new Bad('Invalid JSON')); } });
    });
  }
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        // CSRF defence: state-changing calls must be JSON (cannot be sent by a plain cross-site form) and same-origin
        if (req.method !== 'GET') {
          if (!/^application\/json/.test(req.headers['content-type'] || '') && req.method !== 'DELETE') throw new Bad('JSON required', 415);
          const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) throw new Bad('Cross-origin request blocked', 403);
        }
        const user = userFrom(req); const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
        for (const [m, re, fn] of routes) { const mm = re.exec(url.pathname); if (m === req.method && mm) { const out = fn({ req, res, url, user, body, m: mm }); if (out !== undefined) send(res, 200, out); return; } }
        throw new Bad('Not found', 404);
      }
      if (url.pathname.startsWith('/uploads/')) { // product images only; payment proofs live behind admin auth
        const f = path.join(uploadDir, path.basename(url.pathname));
        const pub = db.prepare('SELECT 1 FROM products WHERE image=?').get(path.basename(url.pathname));
        if (!pub || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' }); return fs.createReadStream(f).pipe(res);
      }
      let f = path.join(pubDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (!f.startsWith(pubDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(pubDir, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
    } catch (e) {
      if (e instanceof Bad) return send(res, e.code, { error: e.message });
      console.error('[error]', e); send(res, 500, { error: 'Something went wrong' });
    }
  });
  return { server, db, close: () => { server.close(); db.close(); } };
}
module.exports = { createApp };

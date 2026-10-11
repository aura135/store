'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), path = require('node:path');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  migrate(db);
  return db;
}

// Ordered migrations. Add new entries at the end; never edit old ones.
const MIGRATIONS = [`
CREATE TABLE users(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('buyer','owner','admin')), shop TEXT, mobile TEXT,
  pass_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE products(
  id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT NOT NULL, image TEXT, ptype TEXT NOT NULL CHECK(ptype IN('packaged','loose','other')),
  unit TEXT NOT NULL, pkg_size REAL, pkg_unit TEXT,
  price_cents INTEGER NOT NULL CHECK(price_cents>0),
  stock INTEGER NOT NULL CHECK(stock>=0),
  discount_pct REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX idx_products_owner ON products(owner_id);
CREATE TABLE orders(
  id INTEGER PRIMARY KEY, buyer_id INTEGER NOT NULL REFERENCES users(id), owner_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL CHECK(method IN('cod','online')),
  status TEXT NOT NULL, pay_status TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL, delivery_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
  address TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, delivered_at TEXT, cancelled_at TEXT);
CREATE INDEX idx_orders_buyer ON orders(buyer_id); CREATE INDEX idx_orders_owner ON orders(owner_id);
CREATE TABLE order_items(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, ptype TEXT NOT NULL, unit TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty>0), unit_price_cents INTEGER NOT NULL, line_cents INTEGER NOT NULL);
CREATE TABLE payment_sessions(
  id INTEGER PRIMARY KEY, buyer_id INTEGER NOT NULL REFERENCES users(id), items TEXT NOT NULL, address TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', expires_at INTEGER NOT NULL);
CREATE TABLE payment_proofs(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), buyer_id INTEGER NOT NULL REFERENCES users(id),
  utr TEXT NOT NULL COLLATE NOCASE, screenshot TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'verification_pending' CHECK(status IN('verification_pending','paid','rejected')),
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, verified_by INTEGER REFERENCES users(id), verified_at TEXT);
CREATE UNIQUE INDEX uq_utr_live ON payment_proofs(utr) WHERE status<>'rejected';
CREATE TABLE audit_log(id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, user_id INTEGER, action TEXT NOT NULL, detail TEXT);
`];

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version(v INTEGER NOT NULL)');
  let cur = db.prepare('SELECT COALESCE(MAX(v),0) v FROM schema_version').get().v;
  for (; cur < MIGRATIONS.length; cur++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[cur]); db.prepare('INSERT INTO schema_version(v) VALUES(?)').run(cur + 1); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
module.exports = { open };

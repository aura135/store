'use strict';
// Pricing/quantity rules. Money = integer paise. Stock = integer: packages, or g/ml for loose products.
const UF = { kg: { f: 1000, fam: 'm' }, g: { f: 1, fam: 'm' }, L: { f: 1000, fam: 'v' }, ml: { f: 1, fam: 'v' } };
class Bad extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }

// Convert buyer-entered quantity (e.g. 500 + 'g') to stored integer (smallest unit). 500 g never becomes 500 kg.
function toStored(p, qty, unit) {
  if (p.ptype !== 'loose') {
    if (!Number.isInteger(qty) || qty < 1) throw new Bad(`${p.name}: enter a whole number of packages`);
    return qty;
  }
  const b = UF[p.unit], u = UF[unit || p.unit];
  if (!b || !u || b.fam !== u.fam) throw new Bad(`${p.name}: invalid unit`);
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) throw new Bad(`${p.name}: quantity must be above 0`);
  const small = Math.round(qty * u.f * 1e6) / 1e6;
  if (Math.abs(small - Math.round(small)) > 1e-6 || Math.round(small) < 1) throw new Bad(`${p.name}: smallest quantity is 1 ${b.fam === 'm' ? 'g' : 'ml'}`);
  return Math.round(small);
}
const unitCents = p => Math.round(p.price_cents * (1 - (p.discount_pct || 0) / 100));
const lineCents = (p, q) => p.ptype === 'loose' ? Math.round(unitCents(p) * q / UF[p.unit].f) : unitCents(p) * q;
const deliveryCents = sub => (sub < 99900 ? 4900 : 0);
const stockText = (p, q) => p.ptype !== 'loose' ? String(q) : (UF[p.unit].f === 1000 && q < 1000 ? `${q} ${UF[p.unit].fam === 'm' ? 'g' : 'ml'}` : `${q / UF[p.unit].f} ${p.unit}`);
module.exports = { UF, Bad, toStored, unitCents, lineCents, deliveryCents, stockText };

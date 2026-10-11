# Quantum Market: backend + existing frontend

Zero-dependency Node.js (>= 22.13) server with a SQLite database. It serves your existing frontend from `public/index.html` and exposes a JSON API under `/api`.

## Status (read this first)
| Part | State |
|---|---|
| Backend API, database, auth, roles, payment-proof flow, pricing rules | **Done and tested** (13 automated tests, all passing) |
| Frontend (`public/index.html`) | **Core workflows connected.** Authentication/session, live product listing and creation, COD checkout, online payment-session/proof submission, buyer/owner order views, buyer cancellation/receipt/COD confirmation, owner product price/stock/status updates, and admin payment verification use the API/database. |
| Deployment | **Not deployed.** Config is provided (`render.yaml`), but nothing has been published. |
| Password reset, email verification | Not implemented (needs an email provider). |

## Frontend integration status
The existing v6 UI now uses the backend for the core order and payment-proof workflows as well as authentication and product management. Some legacy dashboard analytics, profile editing, full owner administration, product deletion, and certain notification/store-pause features still rely on the old UI/local state and are not fully server-backed. Treat this as a local development build, not a production-ready commerce system.

## Run locally
```bash
cp .env.example .env      # set ADMIN_EMAIL and a 12+ character ADMIN_PASSWORD
npm start                 # http://localhost:3000
npm test                  # runs the API test suite on an in-memory database
```
The database is created and migrated automatically on start (`src/db.js`, ordered migrations).

## Layout
- `server.js` entry point. `src/app.js` routes, auth, validation. `src/db.js` schema + migrations. `src/rules.js` pricing and unit conversion.
- `tests/api.test.js` end-to-end API tests. `public/` frontend. `uploads/` payment screenshots and product images (git-ignored).

## API summary
Auth: `POST /api/auth/register|login|logout`, `GET /api/me`. Products: `GET /api/products`, `GET /api/my/products` (owner), `POST /api/products` (owner), `PATCH /api/products/:id` (owner, own only).
Checkout: `POST /api/quote`, `POST /api/orders/cod` (needs `confirm:true`), `POST /api/payments/sessions`, `DELETE /api/payments/sessions/:id` (Back to Order), `POST /api/payments/sessions/:id/proof` (UTR + screenshot).
Orders: `GET /api/orders`, `POST /api/orders/:id/cancel|received|cash-paid`. Admin: `GET /api/admin/payments`, `POST /api/admin/payments/:id/verify`.

## Rules enforced on the server
- Prices, delivery fee and totals are computed from the database; client totals are ignored. 500 g at ₹200/kg = ₹100 (integer maths, in paise).
- An online payment attempt is a *payment session*, not an order. An order is created only when a valid UTR and a real PNG/JPG/WEBP screenshot are submitted, and it starts as `verification_pending`. Only an admin can set `paid`.
- Duplicate submissions and reused UTRs are rejected; stock is decremented atomically so it cannot be oversold.
- Passwords use scrypt; sessions are random tokens (hashed in the DB) in HttpOnly SameSite cookies (`Secure` in production). Auth endpoints are rate limited. Writes must be same-origin JSON.
- Payment proofs are only readable by admins.

## Environment variables
`PORT`, `NODE_ENV`, `DB_PATH`, `UPLOAD_DIR`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `COMMISSION_RATE`. See `.env.example`. No external API keys are needed yet.

## GitHub
```bash
git init && git add . && git commit -m "Quantum Market backend"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## Deploy (Render)
1. Push to GitHub. In Render choose **New > Blueprint** and select the repo (`render.yaml` is used).
2. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` when prompted. HTTPS is provided by Render.
3. SQLite and uploads live on the 1 GB persistent disk at `/var/data`. This needs a paid instance; free instances lose files on restart.

## Backups
Take a consistent copy with `sqlite3 /var/data/qm.db ".backup '/var/data/backup-$(date +%F).db'"`, and copy `/var/data/uploads` too. Store copies off the server. To restore, stop the app and replace `qm.db`.

## Known limitations
Single-server SQLite (fine for a small shop, not for horizontal scaling). Rate limiting is in-memory per process. There is no real payment gateway or generated recipient-specific UPI QR in this build: online proof submission is a manual UTR + screenshot workflow, and the sample QR UI must not be treated as a real payment QR. Some analytics, profile editing, owner administration, deletion, and pause/resume functions remain local-only. Not security-audited or penetration-tested.

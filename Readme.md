# 🌿 EcoGrow — Plant Shop v4.0

## What's New in v4.0 (Bug Fixes + Features)

### 🐛 All Bugs Fixed

| Bug | Severity | Fix |
|---|---|---|
| Hardcoded JWT fallback secrets | **Critical** | Fail-fast in production, warn in dev |
| Order number race condition | **Critical** | Atomic counter via MongoDB `$inc` |
| Hardcoded API URL in frontend | **Critical** | `window.API_BASE` configurable |
| Client-supplied checkout total | **Critical** | Server recomputes price from DB |
| Concurrent overselling | **High** | Atomic `$gte` stock decrement |
| Unbounded refresh token array | **High** | Capped at 10 per user via `$slice` |
| Admin password in logs | **Medium** | Removed from log output |
| Missing promo code index | **Medium** | `promoSchema.index({ code: 1 })` added |
| Cart negative quantity | **Low** | Guard added in `changeQty()` |
| Blocking email in checkout | **High** | Fire-and-forget (non-blocking) |

### ✨ New Features

| Feature | Description |
|---|---|
| **🤖 AI Plant Advisor** | Sage chatbot powered by Claude API — answers plant care questions |
| **🌙 Dark Mode** | System-aware + manual toggle, persisted in localStorage |
| **📊 Revenue Chart** | 30-day revenue line chart in admin analytics (Chart.js) |
| **🌿 Products Tab** | Admin can edit and delete existing products |
| **⬇ CSV Export** | Admin can export orders to CSV for accounting/fulfilment |
| **🔔 Toast Queue** | Multiple toasts stack properly, no more flickering |
| **🔒 Env Validation** | Server fails fast in production if JWT secrets not set |

---

## 🚀 Quick Start

### 1. Prerequisites
- Node.js 18+
- MongoDB running on `localhost:27017`
- (Optional) Anthropic API key for AI advisor

### 2. Install & Run
```bash
# Copy and configure environment
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET, JWT_REFRESH_SECRET

# Install dependencies
npm install

# Start server
npm start

# For hot-reload during development
npm run dev
```

Server starts at: **http://localhost:5000**

### 3. Open Frontend
Open `index.html` directly in your browser, or serve with VS Code Live Server.

> ⚠️ Make sure the server is running before opening the frontend.

### 4. Enable AI Advisor (Optional)
Add to your `.env`:
```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```
Get your key at https://console.anthropic.com. If not set, the chatbot returns a graceful error.

---

## 🔐 Default Credentials

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` (or `ADMIN_DEFAULT_PASSWORD` in .env) |
| Customer | Register via UI | |

> ⚠️ Change the admin password immediately via the Profile modal after first login.

### Default Promo Codes
| Code | Discount |
|---|---|
| `WELCOME10` | 10% off any order |
| `FLAT100` | ₹100 off orders ≥ ₹500 |
| `GREEN20` | 20% off (max ₹500) orders ≥ ₹1000 |

---

## 🔌 API Endpoints (v4 additions)

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/ai/advisor` | AI plant care chatbot (rate limited: 20/min) |
| `GET` | `/api/admin/orders/export` | Download orders as CSV |

All v3 endpoints remain unchanged and fully compatible.

---

## ⚙ Environment Variables

```env
PORT=5000
NODE_ENV=development
MONGO_URI=mongodb://localhost:27017/ecogrow_db

# Required in production — fails fast if not set
JWT_SECRET=your_long_random_string
JWT_REFRESH_SECRET=another_long_random_string

# Optional — enables email notifications
EMAIL_USER=youremail@gmail.com
EMAIL_PASS=your_16_char_app_password
ADMIN_EMAIL=admin@yourdomain.com

# Optional — enables AI advisor chatbot
ANTHROPIC_API_KEY=sk-ant-api03-...

ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:5500
LOW_STOCK_THRESHOLD=5
ADMIN_DEFAULT_PASSWORD=admin123
```

---

## 🏗 Architecture

All code remains in single-file structure for simplicity. Suggested split for Phase 5:

```
ecogrow/
├── src/
│   ├── models/          ← User, Product, Order, Promo, Review, Counter
│   ├── routes/          ← auth.js, products.js, orders.js, admin.js, ai.js
│   ├── middleware/       ← auth.js, rateLimiter.js, validate.js
│   └── services/
│       └── email.js     ← nodemailer templates + sendEmail()
├── server.js            ← express setup + app.listen()
└── .env.example
```

---

## 🚀 Next Steps (Phase 5)

1. **Razorpay/Stripe** — real payment gateway (replace COD)
2. **Cloudinary** — image upload in admin (replace URL entry)
3. **Redis** — cache product listings
4. **Docker** — `docker-compose up` one-command setup
5. **Jest + Supertest** — test suite for auth + checkout
6. **CI/CD** — GitHub Actions deploy pipeline
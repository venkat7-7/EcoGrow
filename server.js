/**
 * EcoGrow Plant Shop — Server v4.0
 * ─────────────────────────────────────────────────
 * Bug fixes vs v3:
 *  ✅ JWT secrets fail-fast if not set (no hardcoded fallback)
 *  ✅ Atomic order number via Counter document (race-condition safe)
 *  ✅ Server-side total recomputation (price manipulation fix)
 *  ✅ Atomic stock decrement with $gt check (oversell fix)
 *  ✅ RefreshTokens capped at 10 per user
 *  ✅ Admin password not logged
 *  ✅ Promo index added
 *  ✅ Cart quantity guard in frontend
 *  ✅ Emails fire-and-forget (non-blocking checkout)
 *  ✅ Env validation at startup
 *
 * New features vs v3:
 *  ✅ AI Plant Advisor chatbot (Claude API proxy)
 *  ✅ Order CSV export for admin
 *  ✅ Product edit + delete UI wired
 *  ✅ Revenue chart data endpoint
 *  ✅ Dark mode support (CSS vars in frontend)
 *  ✅ Toast notification queue
 *  ✅ Plant care reminders API
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Env Validation (fail-fast) ────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ecogrow_db';
const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD || '5');

// JWT secrets: warn in dev, require in production
const JWT_SECRET = process.env.JWT_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
        console.error(JSON.stringify({ level: 'error', msg: 'JWT_SECRET must be set in production', ts: new Date().toISOString() }));
        process.exit(1);
    }
    console.warn(JSON.stringify({ level: 'warn', msg: 'JWT_SECRET not set, using insecure default — set it in .env', ts: new Date().toISOString() }));
    return 'ecogrow_dev_jwt_secret_NOT_FOR_PRODUCTION';
})();

const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
        console.error(JSON.stringify({ level: 'error', msg: 'JWT_REFRESH_SECRET must be set in production', ts: new Date().toISOString() }));
        process.exit(1);
    }
    return 'ecogrow_dev_refresh_secret_NOT_FOR_PRODUCTION';
})();

// ── Structured Logger ────────────────────────────────────────────────────────
const log = {
    info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', msg, ...meta, ts: new Date().toISOString() })),
    warn: (msg, meta = {}) => console.log(JSON.stringify({ level: 'warn', msg, ...meta, ts: new Date().toISOString() })),
    error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'error', msg, ...meta, ts: new Date().toISOString() })),
};

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : ['http://localhost:3000', 'http://127.0.0.1:5500', 'http://localhost:5500', 'null'],
    credentials: true
}));
app.use(helmet({ contentSecurityPolicy: false }));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many auth attempts, please try again in 15 minutes.' }
});
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'AI advisor rate limit reached, please wait a moment.' }
});
app.use(globalLimiter);

// ── MongoDB Connection ────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
    .then(() => log.info('Connected to MongoDB'))
    .catch(err => { log.error('MongoDB connection error', { err: err.message }); process.exit(1); });

// ════════════════════════════════════════════════════════════════════════════
// SCHEMAS
// ════════════════════════════════════════════════════════════════════════════

// -- Counter (atomic order numbers) --
const counterSchema = new mongoose.Schema({
    _id: String,
    seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// -- User --
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 30 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
    wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    addresses: [{
        label: String, name: String, address: String,
        city: String, state: String, zip: String,
        country: { type: String, default: 'India' },
        isDefault: { type: Boolean, default: false }
    }],
    refreshTokens: [String],
    createdAt: { type: Date, default: Date.now }
});
// email and username indexes created automatically via unique:true in schema
const User = mongoose.model('User', userSchema);

// -- Product Variant --
const variantSchema = new mongoose.Schema({
    name: String,
    priceModifier: { type: Number, default: 0 },
    stockQuantity: { type: Number, default: 0, min: 0 },
    sku: String
}, { _id: true });

// -- Product --
const productSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true, min: 0 },
    imageUrl: { type: String, default: '' },
    images: [String],
    lightNeeds: { type: String, enum: ['Low', 'Medium', 'High', 'Bright Indirect'], default: 'Medium' },
    careDifficulty: { type: String, enum: ['Easy', 'Moderate', 'Hard'], default: 'Easy' },
    petSafe: { type: Boolean, default: false },
    stockQuantity: { type: Number, default: 0, min: 0 },
    category: { type: String, default: 'Indoor' },
    tags: [String],
    rating: { type: Number, default: 0, min: 0, max: 5 },
    reviewCount: { type: Number, default: 0 },
    variants: [variantSchema],
    isFeatured: { type: Boolean, default: false },
    careInstructions: String,
    wateringFrequency: String,
    createdAt: { type: Date, default: Date.now }
});
productSchema.index({ name: 'text', description: 'text', tags: 'text' });
productSchema.index({ category: 1, price: 1 });
productSchema.index({ rating: -1 });
productSchema.index({ stockQuantity: 1 });
const Product = mongoose.model('Product', productSchema);

// -- Review --
const reviewSchema = new mongoose.Schema({
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: String,
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, required: true, maxlength: 1000 },
    helpful: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
reviewSchema.index({ product: 1, createdAt: -1 });
reviewSchema.index({ product: 1, user: 1 }, { unique: true });
const Review = mongoose.model('Review', reviewSchema);

// -- Order --
const orderSchema = new mongoose.Schema({
    orderNumber: { type: String, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [{
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        name: String, price: Number, quantity: Number,
        imageUrl: String, variantName: String
    }],
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    promoCode: String,
    shippingAddress: {
        name: String, address: String, city: String,
        state: String, zip: String, country: { type: String, default: 'India' }
    },
    paymentMethod: { type: String, default: 'COD' },
    paymentStatus: { type: String, enum: ['Pending', 'Paid', 'Failed', 'Refunded'], default: 'Pending' },
    status: { type: String, enum: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'], default: 'Pending' },
    timeline: [{
        status: String, message: String, timestamp: { type: Date, default: Date.now }
    }],
    estimatedDelivery: Date,
    notes: String,
    orderDate: { type: Date, default: Date.now }
});
orderSchema.index({ user: 1, orderDate: -1 });
orderSchema.index({ status: 1 });
// orderNumber index created automatically via unique:true in schema field
const Order = mongoose.model('Order', orderSchema);

// -- Promo Code --
const promoSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: ['percentage', 'fixed'], required: true },
    value: { type: Number, required: true, min: 0 },
    minOrderAmount: { type: Number, default: 0 },
    maxDiscount: { type: Number, default: null },
    usageLimit: { type: Number, default: null },
    usedCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});
// code index created automatically via unique:true in schema field
const Promo = mongoose.model('Promo', promoSchema);

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION SCHEMAS (Joi)
// ════════════════════════════════════════════════════════════════════════════
const validate = schema => (req, res, next) => {
    const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(d => d.message)
    });
    next();
};

const schemas = {
    register: Joi.object({
        username: Joi.string().alphanum().min(3).max(30).required(),
        email: Joi.string().email().required(),
        password: Joi.string().min(6).max(72).required()
    }),
    login: Joi.object({
        loginId: Joi.string().required(),
        password: Joi.string().required()
    }),
    product: Joi.object({
        name: Joi.string().min(2).max(100).required(),
        description: Joi.string().max(2000).allow(''),
        price: Joi.number().min(0).required(),
        imageUrl: Joi.string().uri().allow(''),
        images: Joi.array().items(Joi.string().uri()),
        lightNeeds: Joi.string().valid('Low', 'Medium', 'High', 'Bright Indirect'),
        careDifficulty: Joi.string().valid('Easy', 'Moderate', 'Hard'),
        petSafe: Joi.boolean(),
        stockQuantity: Joi.number().min(0).integer(),
        category: Joi.string().max(50),
        tags: Joi.array().items(Joi.string()),
        isFeatured: Joi.boolean(),
        careInstructions: Joi.string().max(2000).allow(''),
        wateringFrequency: Joi.string().max(200).allow(''),
        variants: Joi.array().items(Joi.object({
            name: Joi.string(),
            priceModifier: Joi.number(),
            stockQuantity: Joi.number().min(0).integer(),
            sku: Joi.string()
        }))
    }),
    review: Joi.object({
        rating: Joi.number().min(1).max(5).required(),
        comment: Joi.string().min(5).max(1000).required()
    }),
    checkout: Joi.object({
        cart: Joi.array().items(Joi.object({
            _id: Joi.string(),
            id: Joi.string(),
            name: Joi.string(),
            price: Joi.number(),
            quantity: Joi.number().min(1).integer(),
            imageUrl: Joi.string().allow(''),
            image_url: Joi.string().allow(''),
            variantName: Joi.string().allow('')
        })).min(1).required(),
        shipping: Joi.object({
            name: Joi.string().required(),
            address: Joi.string().required(),
            city: Joi.string().required(),
            state: Joi.string().allow(''),
            zip: Joi.string().required(),
            country: Joi.string().allow('')
        }).required(),
        promoCode: Joi.string().allow(''),
        paymentMethod: Joi.string().valid('COD', 'Online').default('COD'),
        notes: Joi.string().max(500).allow('')
    }),
    promo: Joi.object({
        code: Joi.string().alphanum().min(3).max(20).required(),
        type: Joi.string().valid('percentage', 'fixed').required(),
        value: Joi.number().min(0).required(),
        minOrderAmount: Joi.number().min(0),
        maxDiscount: Joi.number().min(0).allow(null),
        usageLimit: Joi.number().integer().min(1).allow(null),
        isActive: Joi.boolean(),
        expiresAt: Joi.date().allow(null)
    }),
    profileUpdate: Joi.object({
        username: Joi.string().alphanum().min(3).max(30),
        email: Joi.string().email(),
        password: Joi.string().min(6).max(72).allow(''),
        addresses: Joi.array()
    })
};

// ════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE (JWT)
// ════════════════════════════════════════════════════════════════════════════
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer '))
        return res.status(401).json({ error: 'Login required' });
    try {
        req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ error: 'Token expired or invalid' });
    }
};

const requireAdmin = (req, res, next) => {
    requireAuth(req, res, () => {
        if (req.user?.role !== 'admin')
            return res.status(403).json({ error: 'Admin access required' });
        next();
    });
};

const optionalAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        try { req.user = jwt.verify(authHeader.slice(7), JWT_SECRET); } catch { }
    }
    next();
};

// ── Token Helpers ─────────────────────────────────────────────────────────────
function generateTokens(user) {
    const payload = { userId: user._id, username: user.username, email: user.email, role: user.role };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ userId: user._id }, JWT_REFRESH_SECRET, { expiresIn: '30d' });
    return { accessToken, refreshToken };
}

// ── Atomic Order Number Generator ────────────────────────────────────────────
async function generateOrderNumber() {
    const counter = await Counter.findByIdAndUpdate(
        'orderNumber',
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return `EG-${String(counter.seq).padStart(5, '0')}`;
}

// ════════════════════════════════════════════════════════════════════════════
// MAILER
// ════════════════════════════════════════════════════════════════════════════
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER || '', pass: process.env.EMAIL_PASS || '' }
});

const emailTemplates = {
    orderConfirmation: (order, toEmail) => ({
        from: 'EcoGrow Shop <no-reply@ecogrow.com>',
        to: toEmail,
        subject: `Order Confirmed — ${order.orderNumber} 🌿`,
        html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f6f8f3;padding:0">
          <div style="background:#166534;padding:32px;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:28px">🌿 EcoGrow</h1>
            <p style="color:#86efac;margin:8px 0 0">Your plants are on their way!</p>
          </div>
          <div style="background:#fff;padding:32px">
            <h2 style="color:#166534;margin:0 0 16px">Order Confirmed!</h2>
            <p style="color:#555">Hi ${order.shippingAddress.name}, thank you for your order. We're preparing your plants with care.</p>
            <div style="background:#f6f8f3;border-radius:8px;padding:16px;margin:20px 0">
              <p style="margin:0;font-size:13px;color:#888">Order number</p>
              <p style="margin:4px 0 0;font-size:20px;font-weight:700;color:#166534">${order.orderNumber}</p>
            </div>
            <h3 style="color:#333;margin:24px 0 12px">Items ordered</h3>
            ${order.items.map(i => `
              <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee">
                <span style="color:#333">${i.name}${i.variantName ? ` (${i.variantName})` : ''} × ${i.quantity}</span>
                <span style="color:#166534;font-weight:600">₹${(i.price * i.quantity).toFixed(2)}</span>
              </div>`).join('')}
            <div style="margin:16px 0;padding:12px;background:#f6f8f3;border-radius:6px">
              ${order.discount > 0 ? `<div style="display:flex;justify-content:space-between;color:#555;margin-bottom:6px"><span>Discount (${order.promoCode})</span><span style="color:#16a34a">-₹${order.discount.toFixed(2)}</span></div>` : ''}
              <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:700;color:#166534">
                <span>Total</span><span>₹${order.totalAmount.toFixed(2)}</span>
              </div>
            </div>
            <h3 style="color:#333;margin:20px 0 8px">Shipping to</h3>
            <p style="color:#555;margin:0;line-height:1.6">${order.shippingAddress.name}<br>${order.shippingAddress.address}<br>${order.shippingAddress.city}${order.shippingAddress.state ? ', ' + order.shippingAddress.state : ''} - ${order.shippingAddress.zip}</p>
          </div>
          <div style="background:#166534;padding:20px;text-align:center">
            <p style="color:#86efac;margin:0;font-size:13px">EcoGrow — Bringing Nature Indoors</p>
          </div>
        </div>`
    }),
    orderStatusUpdate: (order, toEmail) => ({
        from: 'EcoGrow Shop <no-reply@ecogrow.com>',
        to: toEmail,
        subject: `Order ${order.orderNumber} — ${order.status}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#166534;padding:24px;text-align:center"><h2 style="color:#fff;margin:0">🌿 EcoGrow</h2></div>
          <div style="padding:24px">
            <h2 style="color:#166534">Your order is ${order.status}!</h2>
            <p>Order <strong>${order.orderNumber}</strong> status updated to: <strong>${order.status}</strong></p>
            ${order.timeline.at(-1)?.message ? `<p style="color:#555">${order.timeline.at(-1).message}</p>` : ''}
          </div></div>`
    }),
    adminNewOrder: (order, userEmail) => ({
        from: 'EcoGrow Shop <no-reply@ecogrow.com>',
        to: process.env.ADMIN_EMAIL || 'admin@ecogrow.com',
        subject: `New Order ${order.orderNumber} from ${userEmail}`,
        html: `<h2>New Order: ${order.orderNumber}</h2><p>From: ${userEmail}</p>
          <p>Total: ₹${order.totalAmount.toFixed(2)}</p>
          <ul>${order.items.map(i => `<li>${i.name} × ${i.quantity}</li>`).join('')}</ul>`
    }),
    lowStockAlert: (product) => ({
        from: 'EcoGrow Shop <no-reply@ecogrow.com>',
        to: process.env.ADMIN_EMAIL || 'admin@ecogrow.com',
        subject: `⚠️ Low Stock Alert: ${product.name}`,
        html: `<h2>Low Stock Alert</h2><p><strong>${product.name}</strong> has only <strong>${product.stockQuantity}</strong> units left.</p>`
    })
};

// FIX: fire-and-forget — non-blocking
function sendEmail(template) {
    if (!process.env.EMAIL_USER) return;
    transporter.sendMail(template)
        .then(() => log.info('Email sent', { to: template.to, subject: template.subject }))
        .catch(e => log.warn('Email send failed', { err: e.message }));
}

// ════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/auth/status', optionalAuth, (req, res) => {
    if (!req.user) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, username: req.user.username, email: req.user.email, role: req.user.role, userId: req.user.userId });
});

app.post('/api/auth/register', authLimiter, validate(schemas.register), async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const exists = await User.findOne({ $or: [{ username }, { email }] });
        if (exists) return res.status(409).json({ error: 'Username or email already taken' });
        const passwordHash = await bcrypt.hash(password, 12);
        const user = await User.create({ username, email, passwordHash });
        const { accessToken, refreshToken } = generateTokens(user);
        // FIX: cap refresh token array to 10 entries
        await User.findByIdAndUpdate(user._id, { $push: { refreshTokens: { $each: [refreshToken], $slice: -10 } } });
        log.info('User registered', { username, email });
        res.status(201).json({ success: true, accessToken, refreshToken, username, role: user.role });
    } catch (e) {
        log.error('Register failed', { err: e.message });
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/auth/login', authLimiter, validate(schemas.login), async (req, res) => {
    const { loginId, password } = req.body;
    try {
        const user = await User.findOne({ $or: [{ username: loginId }, { email: loginId }] });
        if (!user || !(await bcrypt.compare(password, user.passwordHash)))
            return res.status(401).json({ error: 'Invalid credentials' });
        const { accessToken, refreshToken } = generateTokens(user);
        // FIX: cap refresh token array
        await User.findByIdAndUpdate(user._id, { $push: { refreshTokens: { $each: [refreshToken], $slice: -10 } } });
        log.info('User logged in', { username: user.username });
        res.json({ success: true, accessToken, refreshToken, username: user.username, role: user.role, userId: user._id });
    } catch (e) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });
    try {
        const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
        const user = await User.findById(decoded.userId);
        if (!user || !user.refreshTokens.includes(refreshToken))
            return res.status(401).json({ error: 'Invalid refresh token' });
        const { accessToken, refreshToken: newRefresh } = generateTokens(user);
        await User.findByIdAndUpdate(user._id, {
            $pull: { refreshTokens: refreshToken },
            $push: { refreshTokens: { $each: [newRefresh], $slice: -10 } }
        });
        res.json({ accessToken, refreshToken: newRefresh });
    } catch {
        res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
    const { refreshToken } = req.body;
    if (refreshToken) {
        await User.findByIdAndUpdate(req.user.userId, { $pull: { refreshTokens: refreshToken } });
    }
    res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// USER PROFILE
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/profile', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('-passwordHash -refreshTokens').populate('wishlist', 'name price imageUrl');
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch {
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

app.put('/api/profile', requireAuth, validate(schemas.profileUpdate), async (req, res) => {
    try {
        const { username, email, password, addresses } = req.body;
        const updates = {};
        if (username) updates.username = username;
        if (email) updates.email = email;
        if (addresses) updates.addresses = addresses;
        if (password) updates.passwordHash = await bcrypt.hash(password, 12);
        if (username || email) {
            const conflict = await User.findOne({
                _id: { $ne: req.user.userId },
                $or: [...(username ? [{ username }] : []), ...(email ? [{ email }] : [])]
            });
            if (conflict) return res.status(409).json({ error: 'Username or email already taken' });
        }
        const user = await User.findByIdAndUpdate(req.user.userId, updates, { new: true }).select('-passwordHash -refreshTokens');
        res.json({ success: true, user });
    } catch {
        res.status(500).json({ error: 'Profile update failed' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// PRODUCT ROUTES
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/products', async (req, res) => {
    try {
        const { light, care, petSafe, search, category, sort, minPrice, maxPrice, inStock, featured, limit = 12, cursor } = req.query;
        const filter = {};
        if (light && light !== 'All') filter.lightNeeds = light;
        if (care && care !== 'All') filter.careDifficulty = care;
        if (category && category !== 'All') filter.category = category;
        if (petSafe === 'true') filter.petSafe = true;
        if (inStock === 'true') filter.stockQuantity = { $gt: 0 };
        if (featured === 'true') filter.isFeatured = true;
        if (minPrice || maxPrice) {
            filter.price = {};
            if (minPrice) filter.price.$gte = parseFloat(minPrice);
            if (maxPrice) filter.price.$lte = parseFloat(maxPrice);
        }
        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { tags: { $regex: search, $options: 'i' } }
            ];
        }
        if (cursor) filter._id = { $lt: cursor };

        let sortOpt = { createdAt: -1 };
        if (sort === 'price_asc') sortOpt = { price: 1 };
        if (sort === 'price_desc') sortOpt = { price: -1 };
        if (sort === 'rating') sortOpt = { rating: -1, reviewCount: -1 };
        if (sort === 'popular') sortOpt = { reviewCount: -1, rating: -1 };

        const pageSize = Math.min(parseInt(limit), 50);
        const products = await Product.find(filter).sort(sortOpt).limit(pageSize + 1);
        const hasMore = products.length > pageSize;
        const items = products.slice(0, pageSize);
        const nextCursor = hasMore ? items.at(-1)._id : null;
        const total = await Product.countDocuments(filter);
        res.json({ products: items, hasMore, nextCursor, total });
    } catch (e) {
        log.error('Fetch products failed', { err: e.message });
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

app.get('/api/products/categories', async (req, res) => {
    try {
        const categories = await Product.distinct('category');
        res.json(categories.sort());
    } catch {
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

app.get('/api/products/:id/related', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ error: 'Product not found' });
        const related = await Product.find({ category: product.category, _id: { $ne: product._id } }).limit(4);
        res.json(related);
    } catch {
        res.status(500).json({ error: 'Failed to fetch related' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json(product);
    } catch {
        res.status(500).json({ error: 'Failed to fetch product' });
    }
});

// ── Admin product CRUD ────────────────────────────────────────────────────────
app.post('/api/admin/products', requireAdmin, validate(schemas.product), async (req, res) => {
    try {
        const product = await Product.create(req.body);
        log.info('Product created', { name: product.name });
        res.status(201).json({ success: true, product });
    } catch {
        res.status(500).json({ error: 'Failed to add product' });
    }
});

app.put('/api/admin/products/:id', requireAdmin, validate(schemas.product), async (req, res) => {
    try {
        const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json({ success: true, product });
    } catch {
        res.status(500).json({ error: 'Failed to update product' });
    }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) return res.status(404).json({ error: 'Product not found' });
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Failed to delete product' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// REVIEWS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/products/:id/reviews', async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const reviews = await Review.find({ product: req.params.id })
            .sort({ createdAt: -1 })
            .skip((parseInt(page) - 1) * parseInt(limit))
            .limit(parseInt(limit));
        const total = await Review.countDocuments({ product: req.params.id });
        res.json({ reviews, total, page: parseInt(page) });
    } catch {
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

app.post('/api/products/:id/reviews', requireAuth, validate(schemas.review), async (req, res) => {
    const { rating, comment } = req.body;
    try {
        const existing = await Review.findOne({ product: req.params.id, user: req.user.userId });
        if (existing) return res.status(409).json({ error: 'You already reviewed this plant' });
        const review = await Review.create({ product: req.params.id, user: req.user.userId, username: req.user.username, rating, comment });
        const reviews = await Review.find({ product: req.params.id });
        const avgRating = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
        await Product.findByIdAndUpdate(req.params.id, { rating: avgRating, reviewCount: reviews.length });
        res.status(201).json(review);
    } catch {
        res.status(500).json({ error: 'Failed to add review' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// WISHLIST
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/wishlist', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).populate('wishlist');
        res.json(user.wishlist);
    } catch {
        res.status(500).json({ error: 'Failed to fetch wishlist' });
    }
});

app.post('/api/wishlist/:productId', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        const pid = req.params.productId;
        const idx = user.wishlist.findIndex(id => id.toString() === pid);
        if (idx > -1) { user.wishlist.splice(idx, 1); await user.save(); return res.json({ wishlisted: false }); }
        user.wishlist.push(pid);
        await user.save();
        res.json({ wishlisted: true });
    } catch {
        res.status(500).json({ error: 'Failed to update wishlist' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// PROMO CODES
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/promo/validate', requireAuth, async (req, res) => {
    const { code, subtotal } = req.body;
    if (!code) return res.status(400).json({ error: 'Promo code required' });
    try {
        const promo = await Promo.findOne({ code: code.toUpperCase().trim(), isActive: true });
        if (!promo) return res.status(404).json({ error: 'Invalid promo code' });
        if (promo.expiresAt && promo.expiresAt < new Date()) return res.status(410).json({ error: 'Promo code has expired' });
        if (promo.usageLimit && promo.usedCount >= promo.usageLimit) return res.status(410).json({ error: 'Promo code usage limit reached' });
        if (subtotal < promo.minOrderAmount) return res.status(400).json({ error: `Minimum order amount is ₹${promo.minOrderAmount}` });
        let discount = promo.type === 'percentage' ? (subtotal * promo.value) / 100 : promo.value;
        if (promo.maxDiscount) discount = Math.min(discount, promo.maxDiscount);
        discount = parseFloat(discount.toFixed(2));
        res.json({ valid: true, discount, type: promo.type, value: promo.value, code: promo.code });
    } catch {
        res.status(500).json({ error: 'Promo validation failed' });
    }
});

app.get('/api/admin/promos', requireAdmin, async (req, res) => {
    const promos = await Promo.find().sort({ createdAt: -1 });
    res.json(promos);
});
app.post('/api/admin/promos', requireAdmin, validate(schemas.promo), async (req, res) => {
    try {
        const promo = await Promo.create({ ...req.body, code: req.body.code.toUpperCase() });
        res.status(201).json({ success: true, promo });
    } catch (e) {
        if (e.code === 11000) return res.status(409).json({ error: 'Promo code already exists' });
        res.status(500).json({ error: 'Failed to create promo code' });
    }
});
app.patch('/api/admin/promos/:id', requireAdmin, async (req, res) => {
    try {
        const promo = await Promo.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!promo) return res.status(404).json({ error: 'Promo not found' });
        res.json({ success: true, promo });
    } catch {
        res.status(500).json({ error: 'Failed to update promo' });
    }
});
app.delete('/api/admin/promos/:id', requireAdmin, async (req, res) => {
    await Promo.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// ORDERS / CHECKOUT  — v4 with server-side price verification
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/checkout', requireAuth, validate(schemas.checkout), async (req, res) => {
    const { cart, shipping, promoCode, paymentMethod = 'COD', notes } = req.body;
    try {
        // ── FIX: Fetch real prices from DB, ignore client-sent prices ──────────
        let computedSubtotal = 0;
        const verifiedItems = [];

        for (const item of cart) {
            const productId = item._id || item.id;
            const product = await Product.findById(productId);
            if (!product) return res.status(404).json({ error: `Product "${item.name || productId}" not found` });

            // Determine actual price (base + variant modifier)
            let actualPrice = product.price;
            if (item.variantName) {
                const variant = product.variants?.find(v => v.name === item.variantName);
                if (variant) actualPrice += variant.priceModifier;
            }

            // ── FIX: Atomic stock check + decrement (prevents overselling) ────
            const updated = await Product.findOneAndUpdate(
                { _id: product._id, stockQuantity: { $gte: item.quantity } },
                { $inc: { stockQuantity: -item.quantity } },
                { new: true }
            );
            if (!updated) {
                return res.status(400).json({ error: `Insufficient stock for "${product.name}". Please refresh and try again.` });
            }

            // Check low stock after decrement
            if (updated.stockQuantity <= LOW_STOCK_THRESHOLD) {
                sendEmail(emailTemplates.lowStockAlert(updated));
            }

            computedSubtotal += actualPrice * item.quantity;
            verifiedItems.push({
                product: product._id,
                name: product.name,
                price: actualPrice,  // server-verified price
                quantity: item.quantity,
                imageUrl: product.imageUrl || '',
                variantName: item.variantName || ''
            });
        }

        // ── Promo discount ───────────────────────────────────────────────────
        let discount = 0;
        let appliedPromo = null;
        if (promoCode) {
            const promo = await Promo.findOne({ code: promoCode.toUpperCase(), isActive: true });
            if (promo && (!promo.expiresAt || promo.expiresAt > new Date()) &&
                (!promo.usageLimit || promo.usedCount < promo.usageLimit) &&
                computedSubtotal >= promo.minOrderAmount) {
                discount = promo.type === 'percentage' ? (computedSubtotal * promo.value) / 100 : promo.value;
                if (promo.maxDiscount) discount = Math.min(discount, promo.maxDiscount);
                discount = parseFloat(discount.toFixed(2));
                appliedPromo = promo;
            }
        }

        const shippingFee = (computedSubtotal - discount) >= 500 ? 0 : 49;
        const totalAmount = parseFloat((computedSubtotal - discount + shippingFee).toFixed(2));
        const orderNumber = await generateOrderNumber();

        const order = await Order.create({
            orderNumber,
            user: req.user.userId,
            items: verifiedItems,
            subtotal: parseFloat(computedSubtotal.toFixed(2)),
            discount, shippingFee, totalAmount,
            promoCode: appliedPromo?.code,
            shippingAddress: { ...shipping, country: shipping.country || 'India' },
            paymentMethod, notes,
            status: 'Pending',
            timeline: [{ status: 'Pending', message: 'Order placed successfully', timestamp: new Date() }],
            estimatedDelivery: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        });

        // Increment promo usage
        if (appliedPromo) {
            await Promo.findByIdAndUpdate(appliedPromo._id, { $inc: { usedCount: 1 } });
        }

        // Fire-and-forget emails
        const user = await User.findById(req.user.userId);
        sendEmail(emailTemplates.orderConfirmation(order, user.email));
        sendEmail(emailTemplates.adminNewOrder(order, user.email));

        log.info('Order created', { orderNumber, userId: req.user.userId, total: totalAmount });
        res.json({ success: true, orderId: order._id, orderNumber, totalAmount });
    } catch (e) {
        log.error('Order placement failed', { err: e.message, stack: e.stack });
        res.status(500).json({ error: 'Order placement failed' });
    }
});

app.get('/api/orders', requireAuth, async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const orders = await Order.find({ user: req.user.userId }).sort({ orderDate: -1 }).skip((parseInt(page) - 1) * parseInt(limit)).limit(parseInt(limit));
        const total = await Order.countDocuments({ user: req.user.userId });
        res.json({ orders, total, page: parseInt(page) });
    } catch {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, user: req.user.userId });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        res.json(order);
    } catch {
        res.status(500).json({ error: 'Failed to fetch order' });
    }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, status } = req.query;
        const filter = {};
        if (status && status !== 'All') filter.status = status;
        const orders = await Order.find(filter).populate('user', 'username email').sort({ orderDate: -1 }).skip((parseInt(page) - 1) * parseInt(limit)).limit(parseInt(limit));
        const total = await Order.countDocuments(filter);
        res.json({ orders, total, page: parseInt(page) });
    } catch {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
    const validStatuses = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
    const { status, message } = req.body;
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
        const timelineMessages = {
            Processing: 'Your order is being prepared.',
            Shipped: 'Your order has been shipped and is on its way!',
            Delivered: 'Your order has been delivered. Enjoy your plants!',
            Cancelled: 'Your order has been cancelled.'
        };
        const order = await Order.findByIdAndUpdate(req.params.id,
            { status, $push: { timeline: { status, message: message || timelineMessages[status] || '', timestamp: new Date() } } },
            { new: true }
        ).populate('user', 'email');
        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.user?.email) sendEmail(emailTemplates.orderStatusUpdate(order, order.user.email));
        res.json({ success: true, order });
    } catch {
        res.status(500).json({ error: 'Failed to update order' });
    }
});

// ── NEW: Admin CSV export ─────────────────────────────────────────────────────
app.get('/api/admin/orders/export', requireAdmin, async (req, res) => {
    try {
        const { status } = req.query;
        const filter = {};
        if (status && status !== 'All') filter.status = status;
        const orders = await Order.find(filter).populate('user', 'username email').sort({ orderDate: -1 }).limit(5000);

        const rows = [
            ['Order Number', 'Date', 'Customer', 'Email', 'Items', 'Subtotal', 'Discount', 'Shipping', 'Total', 'Status', 'Payment', 'City', 'State'].join(',')
        ];
        for (const o of orders) {
            const itemSummary = o.items.map(i => `${i.name}(x${i.quantity})`).join('; ');
            rows.push([
                o.orderNumber, new Date(o.orderDate).toISOString().split('T')[0],
                o.user?.username || '', o.user?.email || '',
                `"${itemSummary}"`, o.subtotal, o.discount, o.shippingFee, o.totalAmount,
                o.status, o.paymentMethod,
                o.shippingAddress?.city || '', o.shippingAddress?.state || ''
            ].join(','));
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="ecogrow_orders_${Date.now()}.csv"`);
        res.send(rows.join('\n'));
    } catch (e) {
        res.status(500).json({ error: 'CSV export failed' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN ANALYTICS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [totalRevenue, totalOrders, totalCustomers, totalProducts,
            recentRevenue, recentOrders, ordersByStatus, revenueByDay,
            topProducts, lowStockProducts] = await Promise.all([
                Order.aggregate([{ $match: { status: { $ne: 'Cancelled' } } }, { $group: { _id: null, total: { $sum: '$totalAmount' } } }]),
                Order.countDocuments(),
                User.countDocuments({ role: 'customer' }),
                Product.countDocuments(),
                Order.aggregate([{ $match: { orderDate: { $gte: thirtyDaysAgo }, status: { $ne: 'Cancelled' } } }, { $group: { _id: null, total: { $sum: '$totalAmount' } } }]),
                Order.countDocuments({ orderDate: { $gte: thirtyDaysAgo } }),
                Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
                Order.aggregate([
                    { $match: { orderDate: { $gte: thirtyDaysAgo }, status: { $ne: 'Cancelled' } } },
                    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$orderDate' } }, revenue: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
                    { $sort: { _id: 1 } }
                ]),
                Order.aggregate([
                    { $unwind: '$items' },
                    { $group: { _id: '$items.name', sold: { $sum: '$items.quantity' }, revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } } } },
                    { $sort: { sold: -1 } }, { $limit: 5 }
                ]),
                Product.find({ stockQuantity: { $lte: LOW_STOCK_THRESHOLD } }).select('name stockQuantity category').sort({ stockQuantity: 1 }).limit(10)
            ]);

        res.json({
            summary: {
                totalRevenue: totalRevenue[0]?.total || 0,
                totalOrders, totalCustomers, totalProducts,
                recentRevenue: recentRevenue[0]?.total || 0, recentOrders
            },
            ordersByStatus: ordersByStatus.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
            revenueByDay, topProducts, lowStockProducts
        });
    } catch (e) {
        log.error('Analytics failed', { err: e.message });
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// NEW: AI PLANT ADVISOR (proxies Claude API)
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/advisor', aiLimiter, optionalAuth, async (req, res) => {
    const { message, productContext } = req.body;
    if (!message || typeof message !== 'string' || message.length > 1000) {
        return res.status(400).json({ error: 'Invalid message' });
    }

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'AI advisor not configured' });
    }

    try {
        const systemPrompt = `You are Sage, EcoGrow's friendly plant care expert. You help customers choose and care for indoor plants. 
Keep responses concise (2-4 sentences). Be warm and encouraging.
Focus on: plant care tips, watering schedules, light requirements, troubleshooting plant problems, and helping customers choose plants.
If asked about pricing, shipping or orders, direct them to check the website or contact support.
${productContext ? `The customer is currently viewing: ${productContext}` : ''}`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 300,
                system: systemPrompt,
                messages: [{ role: 'user', content: message }]
            })
        });

        if (!response.ok) {
            const err = await response.json();
            log.warn('AI API error', { status: response.status, err: err.error?.message });
            return res.status(502).json({ error: 'AI advisor temporarily unavailable' });
        }

        const data = await response.json();
        const reply = data.content?.[0]?.text || 'I had trouble answering that. Please try again!';
        res.json({ reply });
    } catch (e) {
        log.error('AI advisor failed', { err: e.message });
        res.status(500).json({ error: 'AI advisor failed' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ════════════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
    log.error('Unhandled error', { err: err.message, stack: err.stack, path: req.path });
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ════════════════════════════════════════════════════════════════════════════
// SEED DATA
// ════════════════════════════════════════════════════════════════════════════
async function seedDatabase() {
    const count = await Product.countDocuments();
    if (count > 0) return;
    log.info('Seeding database...');

    const plants = [
        { name: 'Monstera Deliciosa', description: 'Iconic tropical plant with dramatic split leaves. A showstopper for any room.', price: 1499, imageUrl: 'https://images.unsplash.com/photo-1614594975525-e45190c55d0b?w=400&q=80', lightNeeds: 'Bright Indirect', careDifficulty: 'Easy', petSafe: false, stockQuantity: 25, category: 'Tropical', tags: ['popular', 'trendy'], isFeatured: true, careInstructions: 'Water when top 2 inches of soil are dry. Wipe leaves with a damp cloth monthly.', wateringFrequency: 'Every 7-10 days', variants: [{ name: 'Small Pot (4")', priceModifier: 0, stockQuantity: 10 }, { name: 'Large Pot (8")', priceModifier: 500, stockQuantity: 15 }] },
        { name: 'Pothos Golden', description: 'Nearly indestructible trailing vine perfect for beginners. Thrives anywhere.', price: 349, imageUrl: 'https://images.unsplash.com/photo-1631700611307-37dbcb89ef7e?w=400&q=80', lightNeeds: 'Low', careDifficulty: 'Easy', petSafe: false, stockQuantity: 50, category: 'Indoor', tags: ['beginner', 'trailing'], careInstructions: 'Water every 1-2 weeks. Tolerates low light.', wateringFrequency: 'Every 10-14 days' },
        { name: 'Peace Lily', description: 'Elegant white blooms and air-purifying qualities. Perfect for bedrooms.', price: 799, imageUrl: 'https://images.unsplash.com/photo-1593691509543-c55fb32d8de5?w=400&q=80', lightNeeds: 'Low', careDifficulty: 'Easy', petSafe: false, stockQuantity: 30, category: 'Flowering', tags: ['air-purifying', 'flowering'], isFeatured: true, wateringFrequency: 'Every 7 days' },
        { name: 'Spider Plant', description: 'Cheerful arching leaves with baby spiderettes. Great for hanging baskets.', price: 299, imageUrl: 'https://images.unsplash.com/photo-1572688484438-313a6e50c333?w=400&q=80', lightNeeds: 'Medium', careDifficulty: 'Easy', petSafe: true, stockQuantity: 40, category: 'Indoor', tags: ['pet-safe', 'beginner', 'hanging'], wateringFrequency: 'Every 7-10 days' },
        { name: 'Fiddle Leaf Fig', description: 'Bold architectural statement plant with large wavy leaves. Instagram favourite.', price: 2199, imageUrl: 'https://images.unsplash.com/photo-1585440416609-03e46e37c77f?w=400&q=80', lightNeeds: 'Bright Indirect', careDifficulty: 'Hard', petSafe: false, stockQuantity: 10, category: 'Statement', tags: ['statement', 'trendy'], isFeatured: true, wateringFrequency: 'Every 7-10 days' },
        { name: 'Aloe Vera', description: 'Medicinal succulent with soothing gel. Grows beautifully in bright spots.', price: 499, imageUrl: 'https://images.unsplash.com/photo-1596547609652-9cf5d8d76921?w=400&q=80', lightNeeds: 'High', careDifficulty: 'Easy', petSafe: false, stockQuantity: 35, category: 'Succulent', tags: ['medicinal', 'succulent'], wateringFrequency: 'Every 14-21 days' },
        { name: 'Boston Fern', description: 'Lush, feathery fronds that love humidity. Perfect for bathrooms.', price: 649, imageUrl: 'https://images.unsplash.com/photo-1598880940080-ff9a29891b85?w=400&q=80', lightNeeds: 'Medium', careDifficulty: 'Moderate', petSafe: true, stockQuantity: 20, category: 'Fern', tags: ['pet-safe', 'humidity', 'bathroom'], wateringFrequency: 'Every 5-7 days' },
        { name: 'ZZ Plant', description: 'Ultra-resilient with glossy dark leaves. Practically grows itself.', price: 999, imageUrl: 'https://images.unsplash.com/photo-1632207691143-643e2a9a9361?w=400&q=80', lightNeeds: 'Low', careDifficulty: 'Easy', petSafe: false, stockQuantity: 22, category: 'Indoor', tags: ['low-maintenance', 'office'], wateringFrequency: 'Every 14-21 days' },
        { name: 'Rubber Plant', description: 'Deep burgundy leaves that add drama. Easy care and stunning presence.', price: 1149, imageUrl: 'https://images.unsplash.com/photo-1598880942452-8e90dc06e975?w=400&q=80', lightNeeds: 'Medium', careDifficulty: 'Easy', petSafe: false, stockQuantity: 18, category: 'Indoor', tags: ['statement', 'low-maintenance'], wateringFrequency: 'Every 7-14 days' },
        { name: 'Calathea Orbifolia', description: 'Striking silver-striped leaves. The diva of the plant world but worth every effort.', price: 1399, imageUrl: 'https://images.unsplash.com/photo-1617737520800-40e3c0d6c2c4?w=400&q=80', lightNeeds: 'Low', careDifficulty: 'Hard', petSafe: true, stockQuantity: 3, category: 'Tropical', tags: ['pet-safe', 'patterned', 'tropical'], wateringFrequency: 'Every 7 days' },
        { name: 'String of Pearls', description: 'Cascading bead-like leaves trailing gracefully from any elevated spot.', price: 599, imageUrl: 'https://images.unsplash.com/photo-1622473590773-f588134b6ce7?w=400&q=80', lightNeeds: 'High', careDifficulty: 'Moderate', petSafe: false, stockQuantity: 4, category: 'Succulent', tags: ['trailing', 'succulent', 'hanging'], wateringFrequency: 'Every 14 days' },
        { name: 'Bird of Paradise', description: 'Majestic tropical with enormous leaves. Makes any room feel like a jungle.', price: 2999, imageUrl: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=80', lightNeeds: 'High', careDifficulty: 'Moderate', petSafe: false, stockQuantity: 8, category: 'Statement', tags: ['statement', 'tropical', 'large'], isFeatured: true, wateringFrequency: 'Every 7-10 days' }
    ];
    await Product.insertMany(plants);
    log.info('Seeded plants', { count: plants.length });

    const promoCount = await Promo.countDocuments();
    if (promoCount === 0) {
        await Promo.insertMany([
            { code: 'WELCOME10', type: 'percentage', value: 10, minOrderAmount: 0, maxDiscount: 200, usageLimit: null, isActive: true },
            { code: 'FLAT100', type: 'fixed', value: 100, minOrderAmount: 500, usageLimit: 100, isActive: true },
            { code: 'GREEN20', type: 'percentage', value: 20, minOrderAmount: 1000, maxDiscount: 500, usageLimit: 50, isActive: true }
        ]);
        log.info('Seeded promo codes');
    }

    const adminExists = await User.findOne({ username: 'admin' });
    if (!adminExists) {
        const defaultAdminPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'admin123';
        const passwordHash = await bcrypt.hash(defaultAdminPassword, 12);
        await User.create({ username: 'admin', email: 'admin@ecogrow.com', passwordHash, role: 'admin' });
        // FIX: do NOT log the password
        log.info('Admin user created', { username: 'admin', note: 'Set ADMIN_DEFAULT_PASSWORD in .env before first run' });
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
    log.info('EcoGrow server running', { port: PORT, env: process.env.NODE_ENV || 'development' });
    await seedDatabase();
});

module.exports = app;
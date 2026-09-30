/* EsauTech backend: Express + PostgreSQL + Safaricom Daraja (M-Pesa STK push). */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const E = process.env;
const PORT = E.PORT || 3000;
const DELIVERY_FEE = parseInt(E.DELIVERY_FEE || "0", 10) || 0;

if (!E.DATABASE_URL || !E.ADMIN_PASSWORD) {
  console.error("Missing DATABASE_URL or ADMIN_PASSWORD. See .env.example.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: E.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(E.DATABASE_URL) ? false : { rejectUnauthorized: false },
});
const q = (text, params) => pool.query(text, params);

/* ---------------- helpers ---------------- */
const safeEq = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const normPhone = (v) => {
  v = String(v || "").replace(/[\s\-+]/g, "");
  if (/^0[17]\d{8}$/.test(v)) return "254" + v.slice(1);
  if (/^254[17]\d{8}$/.test(v)) return v;
  if (/^[17]\d{8}$/.test(v)) return "254" + v;
  return null;
};
const str = (v, min, max) => {
  v = String(v || "").trim();
  return v.length >= min && v.length <= max ? v : null;
};
function limiter(max, ms) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(), k = req.ip;
    let h = hits.get(k);
    if (!h || now > h.reset) h = { n: 0, reset: now + ms };
    h.n++; hits.set(k, h);
    if (h.n > max) return res.status(429).json({ message: "Too many requests. Please wait a few minutes." });
    next();
  };
}

/* ---------------- database ---------------- */
async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS products(
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    cat TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 1),
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    image TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '📦',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS orders(
    id TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    phone TEXT NOT NULL,
    location TEXT NOT NULL,
    items JSONB NOT NULL,
    total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT NOT NULL DEFAULT '',
    checkout_request_id TEXT,
    mpesa_receipt TEXT,
    stock_issue BOOLEAN NOT NULL DEFAULT false,
    fulfilment TEXT NOT NULL DEFAULT 'new',
    last_query TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at TIMESTAMPTZ)`);
  await q("CREATE INDEX IF NOT EXISTS orders_checkout ON orders(checkout_request_id)");

  if (E.SEED_TEST_PRODUCTS !== "false") {
    const { rows } = await q("SELECT count(*)::int AS n FROM products");
    if (rows[0].n === 0) {
      const seed = [
        ["Galaxy A55 5G 8GB/256GB","Samsung","Phones & Tablets",52999,14,"📱"],
        ["iPhone 14 128GB","Apple","Phones & Tablets",94500,6,"📱"],
        ["Redmi Note 13 Pro 8GB/256GB","Xiaomi","Phones & Tablets",36500,22,"📱"],
        ["Pad 10.4in Tablet 4GB/64GB","Lenovo","Phones & Tablets",19800,3,"📟"],
        ["55in 4K Smart TV UHD","Hisense","TVs & Audio",49999,9,"📺"],
        ["43in Full HD Smart TV","TCL","TVs & Audio",27500,12,"📺"],
        ["Soundbar 2.1 Bluetooth 200W","LG","TVs & Audio",15900,0,"🔊"],
        ["Mi Box S Streaming Player","Xiaomi","TVs & Audio",7499,30,"📦"],
        ["Ideapad 15in Core i5 8GB/512GB","Lenovo","Computing",64900,7,"💻"],
        ["Laser Printer M15w Wireless","HP","Computing",18700,5,"🖨️"],
        ["Wireless Mouse and Keyboard","Logitech","Computing",3200,40,"⌨️"],
        ["Double Door Fridge 250L","Ramtons","Home Appliances",42500,4,"🧊"],
        ["Microwave Oven 20L","Von","Home Appliances",8900,16,"🍲"],
        ["Air Fryer 5L Digital","Philips","Home Appliances",13500,11,"🍳"],
        ["Bluetooth Earbuds Pro","Oraimo","Accessories",2499,50,"🎧"],
        ["20000mAh Power Bank","Anker","Accessories",3899,25,"🔋"],
      ];
      for (const s of seed)
        await q("INSERT INTO products(name,brand,cat,price,stock,emoji) VALUES($1,$2,$3,$4,$5,$6)", s);
      console.log("Seeded test products. Delete them from the admin page before going live.");
    }
  }
}

/* ---------------- Daraja ---------------- */
const M = {
  base: E.MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke",
  key: E.MPESA_CONSUMER_KEY, secret: E.MPESA_CONSUMER_SECRET,
  shortcode: E.MPESA_SHORTCODE || "174379", passkey: E.MPESA_PASSKEY,
  type: E.MPESA_TXN_TYPE || "CustomerPayBillOnline",
  partyB: E.MPESA_PARTY_B || E.MPESA_SHORTCODE || "174379",
  cbSecret: E.MPESA_CALLBACK_SECRET, publicUrl: (E.PUBLIC_URL || "").replace(/\/$/, ""),
};
const mpesaReady = () => M.key && M.secret && M.passkey && M.cbSecret && M.publicUrl;
let tok = { v: "", exp: 0 };
async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const r = await fetch(M.base + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + Buffer.from(M.key + ":" + M.secret).toString("base64") },
  });
  if (!r.ok) throw new Error("Daraja authentication failed (" + r.status + ")");
  const d = await r.json();
  tok = { v: d.access_token, exp: Date.now() + (Number(d.expires_in || 3599) - 60) * 1000 };
  return tok.v;
}
async function daraja(path, body) {
  const r = await fetch(M.base + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + (await token()), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {}; try { data = await r.json(); } catch {}
  return { ok: r.ok, data };
}
const stamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const password = (ts) => Buffer.from(M.shortcode + M.passkey + ts).toString("base64");

const FAIL = {
  1: "Insufficient M-Pesa balance.",
  1032: "You cancelled the payment request.",
  1037: "The request timed out. You did not enter your PIN in time.",
  2001: "Wrong M-Pesa PIN entered.",
  1025: "The M-Pesa request could not be sent to your phone.",
};

/* Apply a payment result once. Safe to call from both the callback and the status query. */
async function settle(checkoutId, code, desc, meta = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const o = (await c.query("SELECT * FROM orders WHERE checkout_request_id=$1 FOR UPDATE", [checkoutId])).rows[0];
    if (!o) { await c.query("ROLLBACK"); return; }
    if (o.status !== "pending") {
      if (o.status === "paid" && meta.receipt && !o.mpesa_receipt)
        await c.query("UPDATE orders SET mpesa_receipt=$2 WHERE id=$1", [o.id, meta.receipt]);
      await c.query("COMMIT"); return;
    }
    if (code === 0) {
      if (meta.amount != null && Number(meta.amount) < o.total) {
        await c.query("UPDATE orders SET status='review',message=$2,mpesa_receipt=$3 WHERE id=$1",
          [o.id, "Amount paid (" + meta.amount + ") is less than the order total. Contact support.", meta.receipt || null]);
      } else {
        let issue = false;
        for (const it of o.items) {
          const r = await c.query("UPDATE products SET stock=stock-$2 WHERE id=$1 AND stock>=$2", [it.id, it.qty]);
          if (!r.rowCount) issue = true;
        }
        await c.query("UPDATE orders SET status='paid',paid_at=now(),mpesa_receipt=$2,stock_issue=$3,message='' WHERE id=$1",
          [o.id, meta.receipt || null, issue]);
      }
    } else {
      const msg = (FAIL[code] || desc || "The payment was not completed.") + " You were not charged.";
      await c.query("UPDATE orders SET status='failed',message=$2 WHERE id=$1", [o.id, msg]);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { c.release(); }
}

/* ---------------- app ---------------- */
const app = express();
app.set("trust proxy", 1);
const origins = (E.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }); next(); });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ message: "Server error" }); });

app.get("/", (req, res) => res.json({ name: "EsauTech API", ok: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

/* ----- public: products ----- */
const pub = (p) => ({ id: p.id, name: p.name, brand: p.brand, cat: p.cat, price: p.price, stock: p.stock, image: p.image, emoji: p.emoji });
app.get("/api/products", wrap(async (req, res) => {
  const { rows } = await q("SELECT * FROM products ORDER BY id");
  res.json(rows.map(pub));
}));

/* ----- public: create order (price and stock come from the database, never from the browser) ----- */
app.post("/api/orders", limiter(15, 10 * 60e3), wrap(async (req, res) => {
  const b = req.body || {};
  const customer = str(b.customer, 2, 80), location = str(b.location, 3, 200), phone = normPhone(b.phone);
  if (!customer) return res.status(400).json({ message: "Enter your full name" });
  if (!phone) return res.status(400).json({ message: "Enter a valid Safaricom number" });
  if (!location) return res.status(400).json({ message: "Enter your delivery location" });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 10)
    return res.status(400).json({ message: "No items in order" });

  const want = new Map();
  for (const i of b.items) {
    const id = parseInt(i.id, 10), qty = parseInt(i.qty, 10);
    if (!(id > 0) || !(qty >= 1 && qty <= 20)) return res.status(400).json({ message: "Invalid item" });
    want.set(id, (want.get(id) || 0) + qty);
  }
  const { rows } = await q("SELECT id,name,price,stock FROM products WHERE id = ANY($1)", [[...want.keys()]]);
  const items = []; let total = DELIVERY_FEE;
  for (const [id, qty] of want) {
    const p = rows.find((r) => r.id === id);
    if (!p) return res.status(404).json({ message: "A product is no longer available" });
    if (p.stock < qty) return res.status(409).json({ message: "Not enough stock for " + p.name });
    items.push({ id, name: p.name, price: p.price, qty });
    total += p.price * qty;
  }
  const recent = await q("SELECT count(*)::int AS n FROM orders WHERE phone=$1 AND created_at > now() - interval '10 minutes'", [phone]);
  if (recent.rows[0].n >= 5) return res.status(429).json({ message: "Too many attempts for this number. Try again in a few minutes" });

  const id = "ET" + crypto.randomBytes(4).toString("hex").toUpperCase();
  await q("INSERT INTO orders(id,customer,phone,location,items,total) VALUES($1,$2,$3,$4,$5,$6)",
    [id, customer, phone, location, JSON.stringify(items), total]);
  res.json({ orderId: id, total });
}));

/* ----- public: send the M-Pesa prompt. Amount and phone come from the saved order. ----- */
app.post("/api/mpesa/stkpush", limiter(20, 10 * 60e3), wrap(async (req, res) => {
  if (!mpesaReady()) return res.status(503).json({ message: "M-Pesa is not configured on the server" });
  const o = (await q("SELECT * FROM orders WHERE id=$1", [String((req.body || {}).orderId || "")])).rows[0];
  if (!o) return res.status(404).json({ message: "Order not found" });
  if (o.status !== "pending" || o.checkout_request_id)
    return res.status(409).json({ message: "Payment was already started for this order" });

  for (const it of o.items) {
    const p = (await q("SELECT stock,name FROM products WHERE id=$1", [it.id])).rows[0];
    if (!p || p.stock < it.qty) {
      await q("UPDATE orders SET status='failed',message=$2 WHERE id=$1", [o.id, "An item just went out of stock. You were not charged."]);
      return res.status(409).json({ message: "An item just went out of stock" });
    }
  }
  const ts = stamp();
  let r;
  try {
    r = await daraja("/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: M.shortcode,
      Password: password(ts),
      Timestamp: ts,
      TransactionType: M.type,
      Amount: o.total,
      PartyA: o.phone,
      PartyB: M.partyB,
      PhoneNumber: o.phone,
      CallBackURL: `${M.publicUrl}/api/mpesa/callback/${M.cbSecret}`,
      AccountReference: "ESAUTECH",
      TransactionDesc: "Order " + o.id,
    });
  } catch (e) {
    console.error(e.message);
    await q("UPDATE orders SET status='failed',message=$2 WHERE id=$1", [o.id, "Could not reach M-Pesa. You were not charged."]);
    return res.status(502).json({ message: "Could not reach M-Pesa" });
  }
  if (!r.ok || String(r.data.ResponseCode) !== "0") {
    console.error("STK rejected", r.data);
    await q("UPDATE orders SET status='failed',message=$2 WHERE id=$1", [o.id, "M-Pesa did not accept the request. You were not charged."]);
    return res.status(502).json({ message: "M-Pesa did not accept the request" });
  }
  await q("UPDATE orders SET checkout_request_id=$2 WHERE id=$1", [o.id, r.data.CheckoutRequestID]);
  res.json({ ok: true });
}));

/* ----- Safaricom calls this when the customer pays, cancels or times out ----- */
app.post("/api/mpesa/callback/:secret", wrap(async (req, res) => {
  if (!M.cbSecret || !safeEq(req.params.secret, M.cbSecret)) return res.status(404).end();
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  const cb = req.body && req.body.Body && req.body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return;
  const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const get = (n) => { const i = items.find((x) => x.Name === n); return i ? i.Value : undefined; };
  try {
    await settle(cb.CheckoutRequestID, Number(cb.ResultCode), cb.ResultDesc,
      { receipt: get("MpesaReceiptNumber"), amount: get("Amount") });
  } catch (e) { console.error("callback error", e); }
}));

/* ----- the client polls this. If the callback is slow, we ask Safaricom directly. ----- */
app.get("/api/orders/:id/status", wrap(async (req, res) => {
  const get = async () => (await q("SELECT * FROM orders WHERE id=$1", [req.params.id])).rows[0];
  let o = await get();
  if (!o) return res.status(404).json({ message: "Order not found" });
  const now = Date.now();
  if (o.status === "pending" && o.checkout_request_id && mpesaReady() &&
      now - new Date(o.created_at) > 10000 && (!o.last_query || now - new Date(o.last_query) > 7000)) {
    await q("UPDATE orders SET last_query=now() WHERE id=$1", [o.id]);
    try {
      const ts = stamp();
      const r = await daraja("/mpesa/stkpushquery/v1/query", {
        BusinessShortCode: M.shortcode, Password: password(ts), Timestamp: ts, CheckoutRequestID: o.checkout_request_id,
      });
      if (r.data && r.data.ResultCode !== undefined) {
        await settle(o.checkout_request_id, Number(r.data.ResultCode), r.data.ResultDesc, {});
        o = await get();
      }
    } catch (e) { /* still processing, keep polling */ }
  }
  res.json({ status: o.status, message: o.message });
}));

/* ---------------- admin API (the admin page will use these) ---------------- */
const TOKEN_SECRET = E.TOKEN_SECRET || crypto.createHash("sha256").update("esautech:" + E.ADMIN_PASSWORD).digest("hex");
const sign = (p) => crypto.createHmac("sha256", TOKEN_SECRET).update(p).digest("base64url");
function makeToken() {
  const p = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600e3 })).toString("base64url");
  return p + "." + sign(p);
}
function admin(req, res, next) {
  const t = (req.get("Authorization") || "").replace(/^Bearer /, "");
  const [p, s] = t.split(".");
  try {
    if (p && s && safeEq(s, sign(p)) && JSON.parse(Buffer.from(p, "base64url")).exp > Date.now()) return next();
  } catch {}
  res.status(401).json({ message: "Please log in again" });
}
app.post("/api/admin/login", limiter(8, 15 * 60e3), (req, res) => {
  if (!safeEq((req.body || {}).password || "", E.ADMIN_PASSWORD)) return res.status(401).json({ message: "Wrong password" });
  res.json({ token: makeToken(), expiresInHours: 12 });
});

function cleanProduct(b) {
  const name = str(b.name, 2, 120), cat = str(b.cat, 2, 60), brand = String(b.brand || "").trim().slice(0, 60);
  const price = parseInt(b.price, 10), stock = parseInt(b.stock, 10);
  const image = String(b.image || "").trim(), emoji = String(b.emoji || "📦").trim().slice(0, 8) || "📦";
  if (!name) return { err: "Name must be 2 to 120 characters" };
  if (!cat) return { err: "Choose a category" };
  if (!(price >= 1 && price <= 10000000)) return { err: "Price must be a whole number in KES, 1 or more" };
  if (!(stock >= 0 && stock <= 100000)) return { err: "Quantity must be 0 or more" };
  if (image && (image.length > 400000 || !/^(https?:\/\/|data:image\/)/.test(image))) return { err: "Image must be a web link or a small uploaded image" };
  return { v: [name, brand, cat, price, stock, image, emoji] };
}
app.get("/api/admin/products", admin, wrap(async (req, res) => {
  res.json((await q("SELECT * FROM products ORDER BY id DESC")).rows);
}));
app.post("/api/admin/products", admin, wrap(async (req, res) => {
  const c = cleanProduct(req.body || {}); if (c.err) return res.status(400).json({ message: c.err });
  const r = await q("INSERT INTO products(name,brand,cat,price,stock,image,emoji) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", c.v);
  res.status(201).json(r.rows[0]);
}));
app.put("/api/admin/products/:id", admin, wrap(async (req, res) => {
  const c = cleanProduct(req.body || {}); if (c.err) return res.status(400).json({ message: c.err });
  const r = await q("UPDATE products SET name=$2,brand=$3,cat=$4,price=$5,stock=$6,image=$7,emoji=$8 WHERE id=$1 RETURNING *", [req.params.id, ...c.v]);
  r.rowCount ? res.json(r.rows[0]) : res.status(404).json({ message: "Product not found" });
}));
app.delete("/api/admin/products/:id", admin, wrap(async (req, res) => {
  const r = await q("DELETE FROM products WHERE id=$1", [req.params.id]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ message: "Product not found" });
}));
app.get("/api/admin/orders", admin, wrap(async (req, res) => {
  const s = req.query.status;
  const r = s ? await q("SELECT * FROM orders WHERE status=$1 ORDER BY created_at DESC LIMIT 300", [s])
              : await q("SELECT * FROM orders ORDER BY created_at DESC LIMIT 300");
  res.json(r.rows);
}));
app.patch("/api/admin/orders/:id", admin, wrap(async (req, res) => {
  const f = (req.body || {}).fulfilment;
  if (!["new", "processing", "delivered", "cancelled"].includes(f)) return res.status(400).json({ message: "Invalid status" });
  const r = await q("UPDATE orders SET fulfilment=$2 WHERE id=$1", [req.params.id, f]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ message: "Order not found" });
}));

app.use((err, req, res, next) => res.status(400).json({ message: "Bad request" }));
app.use((req, res) => res.status(404).json({ message: "Not found" }));

initDb().then(() => {
  if (!mpesaReady()) console.warn("M-Pesa keys missing: products work, but payments will return an error until they are set.");
  app.listen(PORT, () => console.log("EsauTech API on port " + PORT));
}).catch((e) => { console.error("Database setup failed:", e.message); process.exit(1); });

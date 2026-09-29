const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const UPLOADS = path.join(ROOT, "uploads");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });
const productsFile = path.join(DATA, "products.json");
const ordersFile = path.join(DATA, "orders.json");
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8"); }
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(UPLOADS));
app.use(express.static(path.join(ROOT, "public")));
const storage = multer.diskStorage({ destination: (_, __, cb) => cb(null, UPLOADS), filename: (_, file, cb) => { const ext = path.extname(file.originalname).toLowerCase() || ".jpg"; cb(null, crypto.randomUUID() + ext); } });
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (_, file, cb) => { const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype); cb(ok ? null : new Error("Разрешены JPG, PNG, WEBP и GIF"), ok); } });
function admin(req, res, next) { const pass = req.headers["x-admin-password"]; if (!pass || pass !== ADMIN_PASSWORD) return res.status(401).json({error:"Неверный пароль администратора"}); next(); }
app.get("/api/products", (_, res) => res.json(readJson(productsFile, [])));
app.post("/api/admin/products", admin, upload.single("image"), (req, res) => {
  const products = readJson(productsFile, []);
  const product = { id: crypto.randomUUID(), name: String(req.body.name || "").trim(), price: Number(req.body.price || 0), description: String(req.body.description || "").trim(), stock: Number(req.body.stock || 0), image: req.file ? "/uploads/" + req.file.filename : "", active: true, createdAt: new Date().toISOString() };
  if (!product.name || !Number.isFinite(product.price) || product.price <= 0) return res.status(400).json({error:"Нужно указать название и цену"});
  products.push(product); writeJson(productsFile, products); res.json(product);
});
app.delete("/api/admin/products/:id", admin, (req, res) => { const products = readJson(productsFile, []); writeJson(productsFile, products.filter(x => x.id !== req.params.id)); res.json({ok:true}); });
app.post("/api/orders", (req, res) => {
  const { customer, items, delivery } = req.body || {};
  if (!customer || !items?.length || !delivery) return res.status(400).json({error:"Заполните покупателя, товары и доставку"});
  const order = { id: "MAX-" + Date.now(), status: "new", customer, items, delivery, createdAt: new Date().toISOString() };
  const orders = readJson(ordersFile, []); orders.push(order); writeJson(ordersFile, orders);
  // Здесь позже подключим официальный Ozon API.
  res.json({ok:true, order});
});
app.get("/api/admin/orders", admin, (_, res) => res.json(readJson(ordersFile, [])));
app.use((err, _, res, __) => res.status(400).json({error: err.message || "Ошибка"}));
app.listen(PORT, () => console.log(`MAX shop listening on ${PORT}`));
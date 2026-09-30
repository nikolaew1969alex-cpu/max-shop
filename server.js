const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

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
app.use(express.static(path.join(ROOT, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 7 },
  fileFilter: (_, file, cb) => {
    const okImage = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype);
    const okVideo = /^video\/(mp4|webm|quicktime)$/.test(file.mimetype);
    cb(okImage || okVideo ? null : new Error("Разрешены JPG, PNG, WEBP, GIF, MP4 и WEBM"), okImage || okVideo);
  }
});
const productMediaUpload = upload.fields([
  { name: "images", maxCount: 6 },
  { name: "video", maxCount: 1 }
]);

function admin(req, res, next) {
  const pass = req.headers["x-admin-password"];
  if (!pass || pass !== ADMIN_PASSWORD) return res.status(401).json({ error: "Неверный пароль администратора" });
  next();
}

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      stock INTEGER NOT NULL DEFAULT 0,
      image_data BYTEA,
      image_mime TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS product_media (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('image','video')),
      data BYTEA NOT NULL,
      mime TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS product_media_product_idx ON product_media(product_id, position);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'new',
      customer JSONB NOT NULL,
      items JSONB NOT NULL,
      delivery TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const count = await pool.query("SELECT COUNT(*)::int AS n FROM products");
  const oldProducts = readJson(productsFile, []);
  if (count.rows[0].n === 0 && oldProducts.length) {
    for (const p of oldProducts) {
      await pool.query(
        `INSERT INTO products (id,name,price,description,stock,active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [p.id || crypto.randomUUID(), p.name || "Товар", Number(p.price) || 0, p.description || "", Number(p.stock) || 0, p.active !== false, p.createdAt || new Date().toISOString()]
      );
    }
    console.log(`Migrated ${oldProducts.length} products to PostgreSQL`);
  }

  const orderCount = await pool.query("SELECT COUNT(*)::int AS n FROM orders");
  const oldOrders = readJson(ordersFile, []);
  if (orderCount.rows[0].n === 0 && oldOrders.length) {
    for (const o of oldOrders) {
      await pool.query(
        `INSERT INTO orders (id,status,customer,items,delivery,created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6) ON CONFLICT DO NOTHING`,
        [o.id, o.status || "new", JSON.stringify(o.customer || {}), JSON.stringify(o.items || []), o.delivery || "", o.createdAt || new Date().toISOString()]
      );
    }
    console.log(`Migrated ${oldOrders.length} orders to PostgreSQL`);
  }
}

async function mediaForProduct(productId) {
  if (!pool) return { images: [], video: "" };
  const { rows } = await pool.query("SELECT id,kind,position FROM product_media WHERE product_id=$1 ORDER BY position,id", [productId]);
  return {
    images: rows.filter(r => r.kind === "image").map(r => `/api/media/${r.id}`),
    video: rows.find(r => r.kind === "video") ? `/api/media/${rows.find(r => r.kind === "video").id}` : ""
  };
}

async function productFromRow(row) {
  const media = await mediaForProduct(row.id);
  const images = media.images.length ? media.images : (row.image_data ? [`/api/images/${row.id}`] : []);
  return {
    id: row.id, name: row.name, price: Number(row.price), description: row.description, stock: row.stock,
    image: images[0] || "", images, video: media.video, active: row.active, createdAt: row.created_at
  };
}

async function getProducts() {
  if (!pool) return readJson(productsFile, []);
  const { rows } = await pool.query("SELECT id,name,price,description,stock,image_data,active,created_at FROM products ORDER BY created_at DESC");
  return Promise.all(rows.map(productFromRow));
}

app.get("/api/products", async (_, res, next) => { try { res.json(await getProducts()); } catch (e) { next(e); } });

app.get("/api/images/:id", async (req, res, next) => {
  try {
    if (!pool) return res.status(404).end();
    const { rows } = await pool.query("SELECT image_data,image_mime FROM products WHERE id=$1", [req.params.id]);
    if (!rows[0]?.image_data) return res.status(404).end();
    res.set("Content-Type", rows[0].image_mime || "image/jpeg");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(rows[0].image_data);
  } catch (e) { next(e); }
});

app.get("/api/media/:id", async (req, res, next) => {
  try {
    if (!pool) return res.status(404).end();
    const { rows } = await pool.query("SELECT data,mime FROM product_media WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).end();
    res.set("Content-Type", rows[0].mime);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(rows[0].data);
  } catch (e) { next(e); }
});

async function saveMedia(productId, files) {
  if (!pool) return;
  const images = files?.images || [];
  const video = files?.video?.[0];
  let position = 0;
  for (const file of images.slice(0, 6)) {
    await pool.query("INSERT INTO product_media (id,product_id,kind,data,mime,position) VALUES ($1,$2,'image',$3,$4,$5)", [crypto.randomUUID(), productId, file.buffer, file.mimetype, position++]);
  }
  if (video) await pool.query("INSERT INTO product_media (id,product_id,kind,data,mime,position) VALUES ($1,$2,'video',$3,$4,$5)", [crypto.randomUUID(), productId, video.buffer, video.mimetype, 99]);
}

app.post("/api/admin/products", admin, productMediaUpload, async (req, res, next) => {
  try {
    const product = { id: crypto.randomUUID(), name: String(req.body.name || "").trim(), price: Number(req.body.price || 0), description: String(req.body.description || "").trim(), stock: Number(req.body.stock || 0), image: "", images: [], video: "", active: true, createdAt: new Date().toISOString() };
    if (!product.name || !Number.isFinite(product.price) || product.price <= 0) return res.status(400).json({ error: "Нужно указать название и цену" });
    const images = req.files?.images || [];
    const video = req.files?.video?.[0];
    if (!pool) {
      const products = readJson(productsFile, []);
      product.images = images.slice(0,6).map((f) => { const filename = crypto.randomUUID() + (path.extname(f.originalname).toLowerCase() || ".jpg"); fs.writeFileSync(path.join(UPLOADS, filename), f.buffer); return "/uploads/" + filename; });
      product.image = product.images[0] || "";
      if (video) { const filename = crypto.randomUUID() + (path.extname(video.originalname).toLowerCase() || ".mp4"); fs.writeFileSync(path.join(UPLOADS, filename), video.buffer); product.video = "/uploads/" + filename; }
      products.push(product); writeJson(productsFile, products); return res.json(product);
    }
    const first = images[0];
    await pool.query(`INSERT INTO products (id,name,price,description,stock,image_data,image_mime,active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [product.id, product.name, product.price, product.description, product.stock, first?.buffer || null, first?.mimetype || null, true, product.createdAt]);
    await saveMedia(product.id, req.files);
    const saved = await productFromRow((await pool.query("SELECT id,name,price,description,stock,image_data,active,created_at FROM products WHERE id=$1", [product.id])).rows[0]);
    res.json(saved);
  } catch (e) { next(e); }
});

app.put("/api/admin/products/:id", admin, productMediaUpload, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!pool) return res.status(503).json({ error: "Редактирование файловой версии временно недоступно" });
    const existing = (await pool.query("SELECT * FROM products WHERE id=$1", [id])).rows[0];
    if (!existing) return res.status(404).json({ error: "Товар не найден" });
    await pool.query("UPDATE products SET name=$1,price=$2,description=$3,stock=$4 WHERE id=$5", [String(req.body.name || existing.name).trim(), Number(req.body.price ?? existing.price), String(req.body.description ?? existing.description).trim(), Number(req.body.stock ?? existing.stock), id]);
    const hasNewImages = (req.files?.images || []).length > 0;
    const hasNewVideo = !!req.files?.video?.[0];
    if (hasNewImages || hasNewVideo) {
      if (hasNewImages) await pool.query("DELETE FROM product_media WHERE product_id=$1 AND kind='image'", [id]);
      if (hasNewVideo) await pool.query("DELETE FROM product_media WHERE product_id=$1 AND kind='video'", [id]);
      await saveMedia(id, req.files);
      if (hasNewImages) { const f=req.files.images[0]; await pool.query("UPDATE products SET image_data=$1,image_mime=$2 WHERE id=$3", [f.buffer,f.mimetype,id]); }
    }
    const row=(await pool.query("SELECT id,name,price,description,stock,image_data,active,created_at FROM products WHERE id=$1",[id])).rows[0];
    res.json(await productFromRow(row));
  } catch(e){ next(e); }
});

app.delete("/api/admin/products/:id", admin, async (req, res, next) => {
  try { if (!pool) { const products=readJson(productsFile,[]); writeJson(productsFile,products.filter(x=>x.id!==req.params.id)); } else await pool.query("DELETE FROM products WHERE id=$1",[req.params.id]); res.json({ok:true}); } catch(e){next(e);}
});

app.post("/api/orders", async (req,res,next)=>{try{const{customer,items,delivery}=req.body||{};if(!customer||!items?.length||!delivery)return res.status(400).json({error:"Заполните покупателя, товары и доставку"});const order={id:"MAX-"+Date.now()+"-"+crypto.randomBytes(2).toString("hex"),status:"new",customer,items,delivery,createdAt:new Date().toISOString()};if(!pool){const orders=readJson(ordersFile,[]);orders.push(order);writeJson(ordersFile,orders)}else await pool.query(`INSERT INTO orders (id,status,customer,items,delivery,created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6)`,[order.id,order.status,JSON.stringify(order.customer),JSON.stringify(order.items),order.delivery,order.createdAt]);res.json({ok:true,order})}catch(e){next(e)}});

app.get("/api/admin/orders",admin,async(_,res,next)=>{try{if(!pool)return res.json(readJson(ordersFile,[]));const{rows}=await pool.query("SELECT id,status,customer,items,delivery,created_at FROM orders ORDER BY created_at DESC");res.json(rows.map(r=>({id:r.id,status:r.status,customer:r.customer,items:r.items,delivery:r.delivery,createdAt:r.created_at})))}catch(e){next(e)}});
app.get("/api/health",async(_,res)=>{if(!pool)return res.json({ok:true,storage:"file"});try{await pool.query("SELECT 1");res.json({ok:true,storage:"postgres"})}catch{res.status(503).json({ok:false,storage:"postgres"})}});
app.use((err,_,res,__)=>res.status(400).json({error:err.message||"Ошибка"}));
(async()=>{if(pool){await initDb();console.log("Persistent PostgreSQL storage enabled")}else console.log("DATABASE_URL is not set; using local file storage");app.listen(PORT,()=>console.log(`MAX shop listening on ${PORT}`))})().catch(err=>{console.error("Database initialization failed",err);process.exit(1)});

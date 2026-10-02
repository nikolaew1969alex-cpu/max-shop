const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const E = process.env;
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const BUCKET = 'media';
const MAX_API = 'https://platform-api.max.ru';

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (_, res) => res.send('ok'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

const eq = (a, b) => {
  a = Buffer.from(String(a || '')); b = Buffer.from(String(b || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const isAdmin = (req, res, next) =>
  E.ADMIN_PASSWORD && eq(req.get('x-admin-token'), E.ADMIN_PASSWORD) ? next() : res.status(401).json({ error: 'Неверный пароль' });
const h = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); });
const ok = r => { if (r.error) throw r.error; return r.data; };
const rub = n => Number(n).toLocaleString('ru-RU') + ' ₽';

// ---------- MAX ----------
async function maxSend(userId, text, attachments) {
  if (!E.MAX_BOT_TOKEN || !userId) return;
  try {
    const r = await fetch(`${MAX_API}/messages?user_id=${userId}`, {
      method: 'POST',
      headers: { Authorization: E.MAX_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachments })
    });
    if (!r.ok) console.error('MAX send', r.status, await r.text());
  } catch (e) { console.error('MAX send failed', e.message); }
}
const shopButton = () => [{ type: 'inline_keyboard', payload: { buttons: [[{ type: 'link', text: 'Открыть магазин', url: E.PUBLIC_URL }]] } }];
const greet = uid => maxSend(uid, 'Здравствуйте! Выбирайте товары в нашем магазине.', shopButton());

app.post('/webhook', (req, res) => {
  if (E.WEBHOOK_SECRET && !eq(req.get('X-Max-Bot-Api-Secret'), E.WEBHOOK_SECRET)) return res.sendStatus(401);
  res.sendStatus(200);
  const u = req.body || {};
  if (u.update_type === 'bot_started') greet(u.user && u.user.user_id);
  else if (u.update_type === 'message_created') {
    const m = u.message || {}, uid = m.sender && m.sender.user_id, t = ((m.body && m.body.text) || '').trim();
    if (t === '/id') maxSend(uid, 'Ваш MAX user_id: ' + uid);
    else greet(uid);
  }
});

async function subscribe() {
  if (!E.MAX_BOT_TOKEN || !E.PUBLIC_URL) return console.log('MAX webhook пропущен: нет MAX_BOT_TOKEN или PUBLIC_URL');
  try {
    const r = await fetch(`${MAX_API}/subscriptions`, {
      method: 'POST',
      headers: { Authorization: E.MAX_BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: E.PUBLIC_URL + '/webhook', update_types: ['bot_started', 'message_created'], secret: E.WEBHOOK_SECRET || undefined })
    });
    console.log('MAX subscribe', r.status, await r.text());
  } catch (e) { console.error('MAX subscribe failed', e.message); }
}

// ---------- Публичное API ----------
app.get('/api/products', h(async (_, res) => {
  res.json(ok(await sb.from('products').select('id,name,description,category,price,image_url').eq('active', true).order('sort').order('id')));
}));

app.post('/api/orders', h(async (req, res) => {
  const { name, phone, address, comment, items } = req.body || {};
  const clean = s => String(s || '').trim().slice(0, 500);
  if (!clean(name) || !clean(address) || clean(phone).replace(/\D/g, '').length < 10 || !Array.isArray(items) || !items.length || items.length > 50)
    return res.status(400).json({ error: 'Проверьте имя, телефон, адрес и корзину' });
  const ids = items.map(i => Number(i.id));
  const prods = ok(await sb.from('products').select('id,name,price').eq('active', true).in('id', ids));
  const lines = [];
  let total = 0;
  for (const i of items) {
    const p = prods.find(x => x.id === Number(i.id)), q = Math.floor(Number(i.qty));
    if (!p || !(q > 0 && q <= 99)) return res.status(400).json({ error: 'Товар недоступен, обновите страницу' });
    lines.push({ id: p.id, name: p.name, price: p.price, qty: q });
    total += p.price * q;
  }
  const order = ok(await sb.from('orders').insert({ name: clean(name), phone: clean(phone), address: clean(address), comment: clean(comment), items: lines, total }).select('id').single());
  maxSend(E.MANAGER_USER_ID, `Новый заказ №${order.id}\n` + lines.map(l => `${l.name} × ${l.qty} = ${rub(l.price * l.qty)}`).join('\n') +
    `\nИтого: ${rub(total)}\nИмя: ${clean(name)}\nТелефон: ${clean(phone)}\nАдрес: ${clean(address)}` + (clean(comment) ? `\nКомментарий: ${clean(comment)}` : ''));
  res.json({ id: order.id, total });
}));

// ---------- Админка ----------
const pick = b => ({
  name: String(b.name || '').trim().slice(0, 200),
  description: String(b.description || '').trim().slice(0, 1000),
  category: String(b.category || 'Без категории').trim().slice(0, 100),
  price: Math.max(0, Math.floor(Number(b.price) || 0)),
  image_url: String(b.image_url || '').slice(0, 1000),
  active: b.active !== false,
  sort: Math.floor(Number(b.sort) || 0)
});
app.get('/api/admin/products', isAdmin, h(async (_, res) => res.json(ok(await sb.from('products').select('*').order('sort').order('id')))));
app.post('/api/admin/products', isAdmin, h(async (req, res) => {
  const p = pick(req.body); if (!p.name) return res.status(400).json({ error: 'Укажите название' });
  res.json(ok(await sb.from('products').insert(p).select().single()));
}));
app.put('/api/admin/products/:id', isAdmin, h(async (req, res) => {
  const p = pick(req.body); if (!p.name) return res.status(400).json({ error: 'Укажите название' });
  res.json(ok(await sb.from('products').update(p).eq('id', req.params.id).select().single()));
}));
app.delete('/api/admin/products/:id', isAdmin, h(async (req, res) => { ok(await sb.from('products').delete().eq('id', req.params.id)); res.json({ ok: true }); }));
app.post('/api/admin/upload', isAdmin, upload.single('file'), h(async (req, res) => {
  const f = req.file;
  if (!f || !EXT[f.mimetype]) return res.status(400).json({ error: 'Нужен файл JPG, PNG, WEBP или GIF до 5 МБ' });
  const key = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${EXT[f.mimetype]}`;
  const r = await sb.storage.from(BUCKET).upload(key, f.buffer, { contentType: f.mimetype });
  if (r.error) throw r.error;
  res.json({ url: sb.storage.from(BUCKET).getPublicUrl(key).data.publicUrl });
}));
app.get('/api/admin/orders', isAdmin, h(async (_, res) => res.json(ok(await sb.from('orders').select('*').order('id', { ascending: false }).limit(100)))));
app.patch('/api/admin/orders/:id', isAdmin, h(async (req, res) => {
  const s = ['new', 'processing', 'done', 'cancelled'].includes(req.body.status) ? req.body.status : null;
  if (!s) return res.status(400).json({ error: 'Неверный статус' });
  ok(await sb.from('orders').update({ status: s }).eq('id', req.params.id)); res.json({ ok: true });
}));

const port = E.PORT || 3000;
app.listen(port, () => { console.log('max-shop on', port); subscribe(); });
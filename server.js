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
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (_, res) => res.send('ok'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 12 } });
const TYPES = {
  'image/jpeg': ['image','jpg'], 'image/png': ['image','png'], 'image/webp': ['image','webp'], 'image/gif': ['image','gif'],
  'video/mp4': ['video','mp4'], 'video/webm': ['video','webm'], 'video/quicktime': ['video','mov']
};
const eq = (a,b) => { a=Buffer.from(String(a||'')); b=Buffer.from(String(b||'')); return a.length===b.length && crypto.timingSafeEqual(a,b); };
const isAdmin = (req,res,next) => E.ADMIN_PASSWORD && eq(req.get('x-admin-token'),E.ADMIN_PASSWORD) ? next() : res.status(401).json({error:'Неверный пароль'});
const h = fn => (req,res) => fn(req,res).catch(e => { console.error(e); res.status(500).json({error:'Ошибка сервера'}); });
const ok = r => { if(r.error) throw r.error; return r.data; };
const rub = n => Number(n).toLocaleString('ru-RU')+' ₽';

async function getSettings(){
  const rows = ok(await sb.from('shop_settings').select('key,value')) || [];
  return Object.fromEntries(rows.map(x => [x.key,x.value]));
}
async function maxSend(userId,text,attachments){
  if(!E.MAX_BOT_TOKEN || !userId) return;
  try{
    const r=await fetch(`${MAX_API}/messages?user_id=${encodeURIComponent(userId)}`,{method:'POST',headers:{Authorization:E.MAX_BOT_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({text,attachments})});
    if(!r.ok) console.error('MAX send',r.status,await r.text());
  }catch(e){console.error('MAX send failed',e.message)}
}
const shopButton=()=>[{type:'inline_keyboard',payload:{buttons:[[{type:'link',text:'Открыть магазин',url:E.PUBLIC_URL}]]}}];
const greet=uid=>maxSend(uid,'Здравствуйте! Выбирайте товары в нашем магазине.',shopButton());
app.post('/webhook',(req,res)=>{
  if(E.WEBHOOK_SECRET && !eq(req.get('X-Max-Bot-Api-Secret'),E.WEBHOOK_SECRET)) return res.sendStatus(401);
  res.sendStatus(200); const u=req.body||{};
  if(u.update_type==='bot_started') greet(u.user&&u.user.user_id);
  else if(u.update_type==='message_created'){
    const m=u.message||{},uid=m.sender&&m.sender.user_id,t=((m.body&&m.body.text)||'').trim();
    if(t==='/id') maxSend(uid,'Ваш MAX user_id: '+uid); else greet(uid);
  }
});
async function subscribe(){
  if(!E.MAX_BOT_TOKEN||!E.PUBLIC_URL) return console.log('MAX webhook пропущен: нет MAX_BOT_TOKEN или PUBLIC_URL');
  try{
    const r=await fetch(`${MAX_API}/subscriptions`,{method:'POST',headers:{Authorization:E.MAX_BOT_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({url:E.PUBLIC_URL+'/webhook',update_types:['bot_started','message_created'],secret:E.WEBHOOK_SECRET||undefined})});
    console.log('MAX subscribe',r.status,await r.text());
  }catch(e){console.error('MAX subscribe failed',e.message)}
}

app.get('/api/products',h(async(_,res)=>{
  const products=ok(await sb.from('products').select('id,name,description,category,price,image_url,active,sort').eq('active',true).order('sort').order('id')) || [];
  const ids=products.map(p=>p.id); let media=[];
  if(ids.length) media=ok(await sb.from('product_media').select('id,product_id,url,media_type,sort').in('product_id',ids).order('sort').order('id')) || [];
  const by={}; media.forEach(m=>(by[m.product_id]??=[]).push(m));
  res.json(products.map(p=>({...p,media:by[p.id]||[]})));
}));
app.get('/api/settings',h(async(_,res)=>{
  const s=await getSettings(); res.json({manager_name:s.manager_name||'Менеджер',manager_phone:s.manager_phone||'',manager_max_url:s.manager_max_url||'',manager_telegram_url:s.manager_telegram_url||''});
}));
app.post('/api/orders',h(async(req,res)=>{
  const {name,phone,address,comment,items}=req.body||{}; const clean=s=>String(s||'').trim().slice(0,500);
  if(!clean(name)||!clean(address)||clean(phone).replace(/\D/g,'').length<10||!Array.isArray(items)||!items.length||items.length>50) return res.status(400).json({error:'Проверьте имя, телефон, адрес и корзину'});
  const ids=items.map(i=>Number(i.id)); const prods=ok(await sb.from('products').select('id,name,price').eq('active',true).in('id',ids));
  const lines=[]; let total=0;
  for(const i of items){const p=prods.find(x=>x.id===Number(i.id)),q=Math.floor(Number(i.qty));if(!p||!(q>0&&q<=99))return res.status(400).json({error:'Товар недоступен, обновите страницу'});lines.push({id:p.id,name:p.name,price:p.price,qty:q});total+=p.price*q;}
  const order=ok(await sb.from('orders').insert({name:clean(name),phone:clean(phone),address:clean(address),comment:clean(comment),items:lines,total}).select('id').single());
  const s=await getSettings(),attachments=[]; if(s.manager_max_url) attachments.push({type:'inline_keyboard',payload:{buttons:[[{type:'link',text:'Связаться с менеджером в MAX',url:s.manager_max_url}]]}});
  maxSend(E.MANAGER_USER_ID,`Новый заказ №${order.id}\n`+lines.map(l=>`${l.name} × ${l.qty} = ${rub(l.price*l.qty)}`).join('\n')+`\nИтого: ${rub(total)}\nИмя: ${clean(name)}\nТелефон: ${clean(phone)}\nАдрес: ${clean(address)}`+(clean(comment)?`\nКомментарий: ${clean(comment)}`:'')+(s.manager_phone?`\nТелефон менеджера: ${s.manager_phone}`:''),attachments);
  res.json({id:order.id,total,manager:{name:s.manager_name||'Менеджер',phone:s.manager_phone||'',max_url:s.manager_max_url||'',telegram_url:s.manager_telegram_url||''}});
}));
const pick=b=>({name:String(b.name||'').trim().slice(0,200),description:String(b.description||'').trim().slice(0,1000),category:String(b.category||'Без категории').trim().slice(0,100),price:Math.max(0,Math.floor(Number(b.price)||0)),image_url:String(b.image_url||'').slice(0,1000),active:b.active!==false,sort:Math.floor(Number(b.sort)||0)});
app.get('/api/admin/products',isAdmin,h(async(_,res)=>{const ps=ok(await sb.from('products').select('*').order('sort').order('id'))||[];const ids=ps.map(p=>p.id);let media=[];if(ids.length)media=ok(await sb.from('product_media').select('id,product_id,url,media_type,sort').in('product_id',ids).order('sort').order('id'))||[];const by={};media.forEach(m=>(by[m.product_id]??=[]).push(m));res.json(ps.map(p=>({...p,media:by[p.id]||[]})))}));
app.post('/api/admin/products',isAdmin,h(async(req,res)=>{const p=pick(req.body);if(!p.name)return res.status(400).json({error:'Укажите название'});res.json(ok(await sb.from('products').insert(p).select().single()))}));
app.put('/api/admin/products/:id',isAdmin,h(async(req,res)=>{const p=pick(req.body);if(!p.name)return res.status(400).json({error:'Укажите название'});res.json(ok(await sb.from('products').update(p).eq('id',req.params.id).select().single()))}));
app.delete('/api/admin/products/:id',isAdmin,h(async(req,res)=>{ok(await sb.from('products').delete().eq('id',req.params.id));res.json({ok:true})}));
app.post('/api/admin/upload',isAdmin,upload.array('files',12),h(async(req,res)=>{const files=req.files||[];if(!files.length)return res.status(400).json({error:'Выберите файлы'});const out=[];for(const f of files){const info=TYPES[f.mimetype];if(!info)return res.status(400).json({error:`Неподдерживаемый файл: ${f.originalname}`});const key=`${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${info[1]}`;const r=await sb.storage.from(BUCKET).upload(key,f.buffer,{contentType:f.mimetype,upsert:false});if(r.error)throw r.error;out.push({url:sb.storage.from(BUCKET).getPublicUrl(key).data.publicUrl,media_type:info[0]})}res.json({files:out})}));
app.post('/api/admin/products/:id/media',isAdmin,h(async(req,res)=>{const id=Number(req.params.id),media=Array.isArray(req.body.media)?req.body.media:[];if(!id||media.length>30)return res.status(400).json({error:'Некорректная галерея'});ok(await sb.from('product_media').delete().eq('product_id',id));if(media.length)ok(await sb.from('product_media').insert(media.map((m,i)=>({product_id:id,url:String(m.url||'').slice(0,2000),media_type:m.media_type==='video'?'video':'image',sort:i}))));const first=media.find(m=>m.media_type!=='video')||media[0];ok(await sb.from('products').update({image_url:first?String(first.url).slice(0,1000):''}).eq('id',id));res.json({ok:true})}));
app.get('/api/admin/settings',isAdmin,h(async(_,res)=>res.json(await getSettings())));
app.put('/api/admin/settings',isAdmin,h(async(req,res)=>{const keys=['manager_name','manager_phone','manager_max_url','manager_telegram_url'];const rows=keys.map(key=>({key,value:String(req.body[key]||'').trim().slice(0,1000)}));ok(await sb.from('shop_settings').upsert(rows,{onConflict:'key'}));res.json(await getSettings())}));
app.get('/api/admin/orders',isAdmin,h(async(_,res)=>res.json(ok(await sb.from('orders').select('*').order('id',{ascending:false}).limit(100)))));
app.patch('/api/admin/orders/:id',isAdmin,h(async(req,res)=>{const s=['new','processing','done','cancelled'].includes(req.body.status)?req.body.status:null;if(!s)return res.status(400).json({error:'Неверный статус'});ok(await sb.from('orders').update({status:s}).eq('id',req.params.id));res.json({ok:true})}));
app.delete('/api/admin/orders/:id',isAdmin,h(async(req,res)=>{const id=Number(req.params.id),o=ok(await sb.from('orders').select('id,status').eq('id',id).single());if(!['done','cancelled'].includes(o.status))return res.status(400).json({error:'Удалять можно только обработанный или отменённый заказ'});ok(await sb.from('orders').delete().eq('id',id));res.json({ok:true})}));
const port=E.PORT||3000;app.listen(port,()=>{console.log('max-shop on',port);subscribe()});
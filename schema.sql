-- Run once in Supabase SQL Editor. Existing products/orders are preserved.
create table if not exists products (
  id bigserial primary key,
  name text not null,
  description text default '',
  category text default 'Без категории',
  price integer not null check (price >= 0),
  image_url text default '',
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists orders (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  address text not null,
  comment text default '',
  items jsonb not null,
  total integer not null,
  status text not null default 'new'
);
create table if not exists product_media (
  id bigserial primary key,
  product_id bigint not null references products(id) on delete cascade,
  url text not null,
  media_type text not null check (media_type in ('image','video')),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists shop_settings (
  key text primary key,
  value text not null default ''
);
alter table products enable row level security;
alter table orders enable row level security;
alter table product_media enable row level security;
alter table shop_settings enable row level security;
insert into storage.buckets (id, name, public) values ('media', 'media', true) on conflict (id) do nothing;
insert into shop_settings(key,value) values ('manager_name','Менеджер'),('manager_phone',''),('manager_max_url',''),('manager_telegram_url','') on conflict (key) do nothing;
insert into product_media(product_id,url,media_type,sort)
select p.id,p.image_url,'image',0 from products p where coalesce(p.image_url,'')<>'' and not exists (select 1 from product_media pm where pm.product_id=p.id and pm.url=p.image_url);
insert into products (name,description,category,price,sort) select 'Сковорода 26 см','Антипригарное покрытие, подходит для индукции','Посуда',1890,1 where not exists (select 1 from products);
insert into products (name,description,category,price,sort) select 'Нож шефа 20 см','Острая сталь, удобная ручка','Приспособления',1290,2 where not exists (select 1 from products where name='Нож шефа 20 см');
insert into products (name,description,category,price,sort) select 'Набор контейнеров','5 штук с герметичными крышками','Хранение',1190,3 where not exists (select 1 from products where name='Набор контейнеров');
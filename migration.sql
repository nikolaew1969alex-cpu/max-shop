-- Выполнить один раз в Supabase SQL Editor.
-- Скрипт идемпотентный и не удаляет существующие товары/заказы.
create table if not exists product_media (
  id bigserial primary key,
  product_id bigint not null references products(id) on delete cascade,
  url text not null,
  media_type text not null check (media_type in ('image','video')),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists shop_settings (key text primary key,value text not null default '');
alter table product_media enable row level security;
alter table shop_settings enable row level security;
insert into storage.buckets (id,name,public) values ('media','media',true) on conflict (id) do nothing;
insert into shop_settings(key,value) values ('manager_name','Менеджер'),('manager_phone',''),('manager_max_url',''),('manager_telegram_url','') on conflict (key) do nothing;
insert into product_media(product_id,url,media_type,sort)
select p.id,p.image_url,'image',0 from products p where coalesce(p.image_url,'')<>'' and not exists (select 1 from product_media pm where pm.product_id=p.id and pm.url=p.image_url);
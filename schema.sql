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
alter table products enable row level security;
alter table orders enable row level security;
insert into storage.buckets (id, name, public) values ('media', 'media', true)
on conflict (id) do nothing;
insert into products (name, description, category, price, sort) values
 ('Сковорода 26 см','Антипригарное покрытие, подходит для индукции','Посуда',1890,1),
 ('Нож шефа 20 см','Острая сталь, удобная ручка','Приспособления',1290,2),
 ('Набор контейнеров','5 штук с герметичными крышками','Хранение',1190,3);
-- Curiosity Pad relay schema. Supabase holds only changes in transit; both
-- devices keep full copies. Paste into the SQL Editor and run once.

-- Every device that syncs (phone, Chrome extension). Used to know who an op
-- is still waiting for.
create table public.devices (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  last_seen  timestamptz not null default now()
);

-- Changes waiting to be delivered. A row is deleted once every device in
-- pending_for has applied it.
create table public.ops (
  seq         bigint generated always as identity primary key,
  id          uuid not null unique,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  device      uuid not null,
  pending_for uuid[] not null,
  op          jsonb not null,
  created     timestamptz not null default now()
);
create index ops_device_idx on public.ops (user_id, device, seq);

-- "I have applied your op." Read by the author device to turn ◐ into ●,
-- then deleted.
create table public.receipts (
  seq        bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  to_device  uuid not null,
  op_id      uuid not null,
  created    timestamptz not null default now()
);
create index receipts_to_idx on public.receipts (user_id, to_device, seq);

-- Only the signed-in owner can touch any of it.
alter table public.devices  enable row level security;
alter table public.ops      enable row level security;
alter table public.receipts enable row level security;

create policy "own devices"  on public.devices  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own ops"      on public.ops      for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own receipts" on public.receipts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Voice notes and images in transit. Private bucket; deleted once delivered.
insert into storage.buckets (id, name, public) values ('media', 'media', false);

create policy "own media" on storage.objects for all to authenticated
  using (bucket_id = 'media' and owner_id = auth.uid()::text)
  with check (bucket_id = 'media');

create table if not exists public.cards (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade, data jsonb not null, updated_at timestamptz default now());
create table if not exists public.attempts (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade, data jsonb not null, updated_at timestamptz default now());
alter table public.cards enable row level security; alter table public.attempts enable row level security;
create policy "own cards" on public.cards for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own attempts" on public.attempts for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create index if not exists cards_user_idx on public.cards(user_id); create index if not exists attempts_user_idx on public.attempts(user_id);

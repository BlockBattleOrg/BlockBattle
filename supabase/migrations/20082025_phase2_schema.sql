-- Phase 2: Schema + RLS + Seed (Top 15 currencies)

-- 1. currencies
create table if not exists currencies (
  id uuid primary key default gen_random_uuid(),
  symbol text not null unique,
  name text not null,
  decimals int not null default 8,
  created_at timestamptz not null default now()
);

-- 2. wallets (1..n per currency)
create table if not exists wallets (
  id uuid primary key default gen_random_uuid(),
  currency_id uuid references currencies(id) on delete cascade,
  address text not null,
  chain text not null,
  created_at timestamptz not null default now(),
  is_active boolean not null default false,
);

-- 3. contributions (raw tx-level records)
create table if not exists contributions (
  id bigserial primary key,
  wallet_id uuid references wallets(id) on delete cascade,
  tx_hash text not null,
  amount numeric not null,
  amount_usd numeric,
  block_time timestamptz not null,
  inserted_at timestamptz not null default now(),
  unique (wallet_id, tx_hash)
);

-- 4. aggregates_daily (pre-computed daily sums per currency)
create table if not exists aggregates_daily (
  id bigserial primary key,
  currency_id uuid references currencies(id) on delete cascade,
  day date not null,
  total_amount numeric not null,
  total_amount_usd numeric not null,
  tx_count int not null,
  unique (currency_id, day)
);

-- 5. settings (misc config: fx rates, countdown date, etc.)
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Enable Row Level Security
alter table currencies enable row level security;
alter table wallets enable row level security;
alter table contributions enable row level security;
alter table aggregates_daily enable row level security;
alter table settings enable row level security;

-- Policies: allow public SELECT
create policy "Allow public read currencies" on currencies for select using (true);
create policy "Allow public read wallets" on wallets for select using (true);
create policy "Allow public read contributions" on contributions for select using (true);
create policy "Allow public read aggregates_daily" on aggregates_daily for select using (true);
create policy "Allow public read settings" on settings for select using (true);

-- Seed 15 currencies (Top 15 list, fixed order)
insert into currencies (symbol, name, decimals) values
  ('BTC', 'Bitcoin', 8),
  ('ETH', 'Ethereum', 18),
  ('SOL', 'Solana', 9),
  ('ADA', 'Cardano', 6),
  ('XRP', 'XRP', 6),
  ('DOGE', 'Dogecoin', 8),
  ('MATIC', 'Polygon', 18),
  ('DOT', 'Polkadot', 10),
  ('ATOM', 'Cosmos', 6),
  ('TRX', 'TRON', 6),
  ('LTC', 'Litecoin', 8),
  ('AVAX', 'Avalanche', 18),
  ('XLM', 'Stellar', 7),
  ('OP', 'Optimism', 18),
  ('ARB', 'Arbitrum', 18)
on conflict (symbol) do nothing;

-- Optional: insert dummy wallets for testing
insert into wallets (currency_id, address, chain)
select id, 'btc_test_wallet', 'bitcoin' from currencies where symbol = 'BTC'
union all
select id, 'eth_test_wallet', 'ethereum' from currencies where symbol = 'ETH'
union all
select id, 'sol_test_wallet', 'solana' from currencies where symbol = 'SOL'
union all
select id, 'ada_test_wallet', 'cardano' from currencies where symbol = 'ADA'
union all
select id, 'xrp_test_wallet', 'xrp' from currencies where symbol = 'XRP'
union all
select id, 'doge_test_wallet', 'dogecoin' from currencies where symbol = 'DOGE'
union all
select id, 'matic_test_wallet', 'polygon' from currencies where symbol = 'MATIC'
union all
select id, 'dot_test_wallet', 'polkadot' from currencies where symbol = 'DOT'
union all
select id, 'atom_test_wallet', 'cosmos' from currencies where symbol = 'ATOM'
union all
select id, 'trx_test_wallet', 'tron' from currencies where symbol = 'TRX'
union all
select id, 'ltc_test_wallet', 'litecoin' from currencies where symbol = 'LTC'
union all
select id, 'avax_test_wallet', 'avalanche' from currencies where symbol = 'AVAX'
union all
select id, 'xlm_test_wallet', 'stellar' from currencies where symbol = 'XLM'
union all
select id, 'op_test_wallet', 'optimism' from currencies where symbol = 'OP'
union all
select id, 'arb_test_wallet', 'arbitrum' from currencies where symbol = 'ARB';


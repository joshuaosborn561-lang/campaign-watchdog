create table if not exists public.campaign_watchdog_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_key text not null unique,
  campaign_id bigint not null,
  client_name text,
  campaign_name text,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists campaign_watchdog_alerts_campaign_id_idx
  on public.campaign_watchdog_alerts (campaign_id, created_at desc);

alter table public.campaign_watchdog_alerts enable row level security;

create table if not exists public.campaign_watchdog_secrets (
  id text primary key,
  access_token text,
  refresh_token text,
  updated_at timestamptz not null default now()
);

alter table public.campaign_watchdog_secrets enable row level security;

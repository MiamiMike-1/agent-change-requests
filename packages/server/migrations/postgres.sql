-- Agent Change Requests: tables for a Postgres-backed ChangeRequestStore (Supabase included).
-- Apply with your normal migration process. Only the server should read or write these
-- tables: row level security is on and no policies are created, so the anon and
-- authenticated roles cannot reach them. Use the service role from server code.

create table if not exists acr_change_requests (
  request_id      text primary key,
  principal       text not null,
  idempotency_key text not null,
  status          text not null,
  about           text not null default 'app' check (about in ('app', 'spec')),
  unread          boolean not null default false,
  created_at      timestamptz not null,
  updated_at      timestamptz not null,
  -- The full ChangeRequestRecord as JSON. The columns above are copies for querying.
  record          jsonb not null,
  unique (principal, idempotency_key)
);

create index if not exists acr_change_requests_inbox
  on acr_change_requests (principal, updated_at desc, request_id);
create index if not exists acr_change_requests_created
  on acr_change_requests (principal, created_at);
create index if not exists acr_change_requests_unread
  on acr_change_requests (principal) where unread;

create table if not exists acr_gaps (
  id        bigint generated always as identity primary key,
  principal text not null,
  target    text not null,
  reason    text not null,
  at        timestamptz not null
);

create index if not exists acr_gaps_principal_at on acr_gaps (principal, at);

alter table acr_change_requests enable row level security;
alter table acr_gaps enable row level security;

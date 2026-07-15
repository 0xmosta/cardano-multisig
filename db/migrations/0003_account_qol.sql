alter table cm_accounts
  add column if not exists contacts_json jsonb not null default '[]'::jsonb,
  add column if not exists preferences_json jsonb not null default '{"notificationsEnabled":false,"defaultTransactionFilter":"action"}'::jsonb;

alter table cm_account_sessions
  add column if not exists user_agent text,
  add column if not exists last_seen_at timestamptz;

update cm_account_sessions
set last_seen_at = coalesce(last_seen_at, last_authenticated_at, created_at)
where last_seen_at is null;

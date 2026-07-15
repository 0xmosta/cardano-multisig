alter table cm_account_sessions
  add column if not exists label text;

alter table cm_relay_rooms
  add column if not exists owner_subject text;

create index if not exists cm_relay_rooms_owner_idx
  on cm_relay_rooms (network, owner_subject)
  where owner_subject is not null;

create table if not exists cm_push_subscriptions (
  id text primary key,
  network text not null,
  subject text not null,
  session_id text not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (network, subject, endpoint),
  foreign key (network, subject) references cm_accounts(network, subject) on delete cascade,
  foreign key (session_id) references cm_account_sessions(id) on delete cascade
);

create index if not exists cm_push_subscriptions_account_idx
  on cm_push_subscriptions (network, subject);

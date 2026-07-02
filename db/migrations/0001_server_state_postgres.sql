create table if not exists cm_schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists cm_accounts (
  network text not null,
  subject text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (network, subject)
);

create table if not exists cm_account_identities (
  network text not null,
  subject text not null,
  kind text not null,
  key_hash text not null,
  address_hex text not null,
  created_at timestamptz not null,
  last_authenticated_at timestamptz not null,
  primary key (network, subject, kind, key_hash),
  foreign key (network, subject) references cm_accounts(network, subject) on delete cascade
);

create table if not exists cm_account_wallets (
  network text not null,
  subject text not null,
  wallet_id text not null,
  wallet_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null,
  primary key (network, subject, wallet_id),
  foreign key (network, subject) references cm_accounts(network, subject) on delete cascade
);

create table if not exists cm_account_transactions (
  network text not null,
  subject text not null,
  tx_id text not null,
  tx_json jsonb not null,
  status text,
  tx_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null,
  primary key (network, subject, tx_id),
  foreign key (network, subject) references cm_accounts(network, subject) on delete cascade
);
create index if not exists cm_account_transactions_status_idx on cm_account_transactions (network, status);
create index if not exists cm_account_transactions_tx_hash_idx on cm_account_transactions (tx_hash);

create table if not exists cm_account_audit_events (
  network text not null,
  subject text not null,
  id text not null,
  event_type text not null,
  created_at timestamptz not null,
  details_json jsonb,
  primary key (network, subject, id),
  foreign key (network, subject) references cm_accounts(network, subject) on delete cascade
);
create index if not exists cm_account_audit_events_type_idx on cm_account_audit_events (network, event_type, created_at desc);

create table if not exists cm_account_sessions (
  id text primary key,
  network text not null,
  subject text not null,
  csrf_token text not null,
  identity_kind text not null,
  identity_key_hash text not null,
  identity_address_hex text not null,
  created_at timestamptz not null,
  last_authenticated_at timestamptz not null,
  expires_at timestamptz not null
);
create index if not exists cm_account_sessions_subject_idx on cm_account_sessions (network, subject);
create index if not exists cm_account_sessions_expires_idx on cm_account_sessions (expires_at);

create table if not exists cm_account_challenges (
  id text primary key,
  network text not null,
  origin text not null,
  subject text not null,
  identity_kind text not null,
  identity_key_hash text not null,
  identity_address_hex text not null,
  identity_created_at timestamptz not null,
  identity_last_authenticated_at timestamptz not null,
  payload_hex text not null,
  nonce text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index if not exists cm_account_challenges_subject_idx on cm_account_challenges (network, subject);
create index if not exists cm_account_challenges_expires_idx on cm_account_challenges (expires_at);

create table if not exists cm_relay_rooms (
  id text primary key,
  network text not null,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  tx_json jsonb not null,
  coordinator_token_hash text not null,
  coordinator_last_seen_at timestamptz,
  shared_signer_token_hash text,
  shared_signer_last_seen_at timestamptz,
  submission_tx_hash text,
  submission_submitted_at timestamptz,
  submission_failure_error text,
  submission_failure_failed_at timestamptz
);
create index if not exists cm_relay_rooms_network_status_idx on cm_relay_rooms (network, status, updated_at desc);
create index if not exists cm_relay_rooms_expires_idx on cm_relay_rooms (expires_at);
create unique index if not exists cm_relay_rooms_coordinator_token_idx on cm_relay_rooms (coordinator_token_hash);
create unique index if not exists cm_relay_rooms_shared_signer_token_idx on cm_relay_rooms (shared_signer_token_hash) where shared_signer_token_hash is not null;
create index if not exists cm_relay_rooms_submission_tx_hash_idx on cm_relay_rooms (submission_tx_hash);

create table if not exists cm_relay_room_signers (
  room_id text not null references cm_relay_rooms(id) on delete cascade,
  key_hash text not null,
  label text,
  token_hash text not null,
  created_at timestamptz not null,
  last_seen_at timestamptz,
  delivered_at timestamptz,
  primary key (room_id, key_hash)
);
create unique index if not exists cm_relay_room_signers_token_idx on cm_relay_room_signers (token_hash);

create table if not exists cm_relay_room_witnesses (
  room_id text not null references cm_relay_rooms(id) on delete cascade,
  witness_id text not null,
  source text not null,
  signer_key_hash_claim text,
  matched_signer_key_hash text,
  witness_cbor text not null,
  wallet_name text,
  signer_name text,
  signed_at timestamptz not null,
  received_at timestamptz not null,
  match_status text not null,
  primary key (room_id, witness_id)
);
create index if not exists cm_relay_room_witnesses_matched_idx on cm_relay_room_witnesses (room_id, matched_signer_key_hash);

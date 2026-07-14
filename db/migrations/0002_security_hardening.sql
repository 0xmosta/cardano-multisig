create table if not exists cm_api_rate_limits (
  scope text not null,
  actor_hash text not null,
  window_start timestamptz not null,
  request_count integer not null,
  expires_at timestamptz not null,
  primary key (scope, actor_hash, window_start)
);

create index if not exists cm_api_rate_limits_expires_idx on cm_api_rate_limits (expires_at);

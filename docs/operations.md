# Production operations

## Health monitoring

`GET /api/health` verifies the configured network and a live PostgreSQL query. The production image uses the same endpoint for its Docker health check. External uptime monitoring should alert on a non-200 response without relying on authenticated application routes.

## PostgreSQL backups

Create a custom-format backup without printing the database connection string:

```bash
DATABASE_URL=... BACKUP_PATH=/secure/backups/cardano-multisig.dump npm run db:backup
```

Check archive readability on every backup:

```bash
BACKUP_PATH=/secure/backups/cardano-multisig.dump npm run db:backup:verify
```

For a full restore drill, provision an isolated database whose name contains `backup`, `restore`, `verify`, or `test`, then run:

```bash
BACKUP_PATH=/secure/backups/cardano-multisig.dump \
RESTORE_CHECK_DATABASE_URL=... \
ALLOW_DESTRUCTIVE_RESTORE_CHECK=1 \
npm run db:backup:verify
```

Never set `RESTORE_CHECK_DATABASE_URL` to production. Schedule the backup and verification commands outside the application container, store archives on encrypted durable storage, and alert on non-zero exit. A daily backup with a weekly isolated restore drill is a sensible baseline; retention depends on the operator's recovery requirements.

The `pg_dump` client must be the same major version as the PostgreSQL server or newer. Set `PG_DUMP_BIN` and `PG_RESTORE_BIN` when the matching tools are installed under versioned paths.

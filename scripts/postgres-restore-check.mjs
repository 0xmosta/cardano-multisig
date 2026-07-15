import { spawn } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";

function run(command, args, env, stdio = "inherit") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function postgresEnv(connectionString) {
  const url = new URL(connectionString);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGSSLMODE: url.searchParams.get("sslmode") || process.env.DATABASE_SSLMODE || "prefer",
  };
}

const backupPath = path.resolve(process.env.BACKUP_PATH || "");
if (!process.env.BACKUP_PATH) throw new Error("BACKUP_PATH is required.");
const pgRestore = process.env.PG_RESTORE_BIN || "pg_restore";
await run(pgRestore, ["--list", backupPath], process.env, ["ignore", "ignore", "inherit"]);

const restoreUrl = (process.env.RESTORE_CHECK_DATABASE_URL || "").trim();
if (restoreUrl) {
  const productionUrl = (process.env.DATABASE_URL || "").trim();
  const databaseName = new URL(restoreUrl).pathname.replace(/^\//, "");
  if (process.env.ALLOW_DESTRUCTIVE_RESTORE_CHECK !== "1") throw new Error("Set ALLOW_DESTRUCTIVE_RESTORE_CHECK=1 for an isolated restore-check database.");
  if (!databaseName || !/(backup|restore|verify|test)/i.test(databaseName)) throw new Error("Restore-check database name must contain backup, restore, verify, or test.");
  if (productionUrl && restoreUrl === productionUrl) throw new Error("Refusing to restore over DATABASE_URL.");
  await run(pgRestore, ["--dbname", databaseName, "--clean", "--if-exists", "--no-owner", "--no-privileges", backupPath], postgresEnv(restoreUrl));
  const pool = new Pool({ connectionString: restoreUrl, application_name: "cardano-multisig-restore-check" });
  try {
    const result = await pool.query("select count(*)::int as count from cm_schema_migrations");
    if (!result.rows[0]?.count) throw new Error("Restored database has no schema migrations.");
  } finally {
    await pool.end();
  }
  console.log("Isolated restore check passed.");
}

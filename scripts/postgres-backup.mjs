import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
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

const databaseUrl = (process.env.DATABASE_URL || "").trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = path.resolve(process.env.BACKUP_PATH || `backups/cardano-multisig-${timestamp}.dump`);
await mkdir(path.dirname(output), { recursive: true });
await run(process.env.PG_DUMP_BIN || "pg_dump", ["--format=custom", "--compress=9", "--no-owner", "--no-privileges", "--file", output], postgresEnv(databaseUrl));
console.log(`Backup created: ${output}`);

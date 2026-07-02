import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const migrationsDir = path.join(root, "db", "migrations");
const databaseUrl = (process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || "").trim();

if (!databaseUrl) {
  console.error("DATABASE_URL or MIGRATION_DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, application_name: "cardano-multisig-migrate" });

try {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`create table if not exists cm_schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const applied = await client.query(`select 1 from cm_schema_migrations where name = $1`, [file]);
      if (applied.rowCount) {
        console.log(`skip ${file}`);
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      console.log(`apply ${file}`);
      await client.query(sql);
      await client.query(`insert into cm_schema_migrations (name) values ($1)`, [file]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

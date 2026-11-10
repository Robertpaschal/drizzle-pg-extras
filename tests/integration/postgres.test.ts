import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { splitMigrationSql } from "../../src/index.js";
import { run } from "../../src/cli.js";

const url = process.env.POSTGRES_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.tmp");
const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/drizzle-kit/bin.cjs");
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");

describe.skipIf(!url)("postgres", () => {
  it("applies extras with drizzle-kit migrate, fires the trigger, and rolls the down file back", async () => {
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "pg-"));
    writeFileSync(
      path.join(dir, "schema.ts"),
      `import { sql } from "drizzle-orm";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { pgExtension, pgFunction, pgTrigger, withComment } from ${JSON.stringify(source)};

export const pgcrypto = pgExtension("pgcrypto");

export const setUpdatedAt = pgFunction("set_updated_at", {
  returns: "trigger",
  language: "plpgsql",
  security: "definer",
  searchPath: [],
  body: "BEGIN\\n  NEW.updated_at = now();\\n  RETURN NEW;\\nEND;",
});

export const users = withComment(pgTable("users", {
  id: serial("id").primaryKey(),
  email: withComment(text("email").notNull(), "User's login email"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}), "Application users");

export const usersTouch = pgTrigger("users_set_updated_at", {
  table: users,
  timing: "before",
  events: ["update"],
  when: ({ OLD, NEW }) => sql\`\${OLD.email} IS DISTINCT FROM \${NEW.email}\`,
  function: setUpdatedAt,
});
`,
    );
    writeFileSync(
      path.join(dir, "drizzle.config.ts"),
      `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.POSTGRES_URL! },
});
`,
    );

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const cwd = process.cwd();
    try {
      await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await client.query("DROP SCHEMA IF EXISTS public CASCADE");
      await client.query("CREATE SCHEMA public");
      await client.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");

      const table = kitExec(dir, ["generate", "--name", "users", "--config", "drizzle.config.ts"]);
      expect(table.status, table.stderr + table.stdout).toBe(0);

      process.chdir(dir);
      expect(await run(["generate", "--name", "extras"])).toBe(0);
      process.chdir(cwd);

      const migrate = kitExec(dir, ["migrate", "--config", "drizzle.config.ts"]);
      expect(migrate.status, migrate.stderr + migrate.stdout).toBe(0);

      const upFile = path.join(dir, "drizzle", "0001_extras.sql");
      const upSql = readFileSync(upFile, "utf8");
      expect(upSql).toContain("CREATE OR REPLACE TRIGGER");
      expect(upSql).toContain("CREATE EXTENSION IF NOT EXISTS");
      await runStatements(client, upSql);

      const inserted = await client.query<{ id: number }>("INSERT INTO users (email) VALUES ('a@a.com') RETURNING id");
      const id = inserted.rows[0]!.id;
      const same = await client.query<{ updated_at: Date }>(
        "UPDATE users SET email = 'a@a.com', updated_at = '2000-01-01' WHERE id = $1 RETURNING updated_at",
        [id],
      );
      expect(same.rows[0]!.updated_at.getUTCFullYear()).toBe(2000);

      const changed = await client.query<{ updated_at: Date }>(
        "UPDATE users SET email = 'b@b.com', updated_at = '2000-01-01' WHERE id = $1 RETURNING updated_at",
        [id],
      );
      expect(changed.rows[0]!.updated_at.getUTCFullYear()).toBeGreaterThan(2000);

      const comment = await client.query<{ table_comment: string; column_comment: string }>(
        `SELECT obj_description(c.oid) AS table_comment,
                col_description(c.oid, a.attnum) AS column_comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'email'
         WHERE n.nspname = 'public' AND c.relname = 'users'`,
      );
      expect(comment.rows[0]).toEqual({ table_comment: "Application users", column_comment: "User's login email" });
      const extension = await client.query("SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'");
      expect(extension.rowCount).toBe(1);

      const before = sqlFiles(path.join(dir, "drizzle"));
      const again = kitExec(dir, ["generate", "--name", "noop", "--config", "drizzle.config.ts"]);
      expect(again.status, again.stderr + again.stdout).toBe(0);
      expect(again.stdout).toContain("No schema changes");
      expect(sqlFiles(path.join(dir, "drizzle"))).toEqual(before);

      await runStatements(client, readFileSync(path.join(dir, "drizzle", "0001_extras.down.sql"), "utf8"));
      const trigger = await client.query(
        "SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'users' AND NOT t.tgisinternal",
      );
      expect(trigger.rowCount).toBe(0);
      const fn = await client.query("SELECT proname FROM pg_proc JOIN pg_namespace n ON n.oid = pronamespace WHERE n.nspname = 'public' AND proname = 'set_updated_at'");
      expect(fn.rowCount).toBe(0);
      const cleared = await client.query<{ table_comment: string | null }>(
        "SELECT obj_description('public.users'::regclass) AS table_comment",
      );
      expect(cleared.rows[0]!.table_comment).toBeNull();
      const gone = await client.query("SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'");
      expect(gone.rowCount).toBe(0);
      const still = await client.query("SELECT email FROM users WHERE id = $1", [id]);
      expect(still.rows[0]!.email).toBe("b@b.com");
    } finally {
      process.chdir(cwd);
      await client.end();
    }
  });
});

function kitExec(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [kit, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

async function runStatements(client: pg.Client, file: string): Promise<void> {
  for (const statement of splitMigrationSql(file)) {
    await client.query(statement);
  }
}

function sqlFiles(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql")).sort();
}

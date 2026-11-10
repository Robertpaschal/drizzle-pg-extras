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

function schemaSource(options: { initially: "deferred" | "immediate"; enabled: boolean }): string {
  return `import { sql } from "drizzle-orm";
import { integer, pgTable, pgView, serial, text } from "drizzle-orm/pg-core";
import { pgFunction, pgTrigger, withComment } from ${JSON.stringify(source)};

export const customers = pgTable("customers", { id: serial("id").primaryKey() });

export const balances = pgTable("balances", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull(),
  amount: integer("amount").notNull(),
  note: text("note"),
});

export const ledger = pgTable("ledger", {
  id: serial("id").primaryKey(),
  amount: integer("amount").notNull(),
});

export const ledgerAudit = pgTable("ledger_audit", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  n: integer("n").notNull(),
});

export const profiles = pgTable("profiles", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  touches: integer("touches").notNull().default(0),
});

export const profileEmails = pgView("profile_emails", {
  id: integer("id"),
  email: text("email"),
}).as(sql\`select id, email from profiles\`);

export const rejectNegative = pgFunction("reject_negative", {
  returns: "trigger",
  language: "plpgsql",
  body: "BEGIN\\n  IF NEW.amount < 0 THEN\\n    RAISE EXCEPTION 'negative balance';\\n  END IF;\\n  RETURN NEW;\\nEND;",
});

export const balancesAmount = withComment(pgTrigger("balances_amount", {
  table: balances,
  timing: "after",
  events: ["insert", "update"],
  columns: [balances.amount],
  constraint: { deferrable: true, initially: "${options.initially}", from: customers },
  function: rejectNegative,
}), "non-negative");

export const countInserted = pgFunction("count_inserted", {
  returns: "trigger",
  language: "plpgsql",
  body: "BEGIN\\n  INSERT INTO ledger_audit (kind, n) SELECT 'insert', count(*)::integer FROM inserted;\\n  RETURN NULL;\\nEND;",
});

export const ledgerInserted = pgTrigger("ledger_inserted", {
  table: ledger,
  timing: "after",
  events: ["insert"],
  forEach: "statement",
  referencing: { newTable: "inserted" },
  function: countInserted,
});

export const countUpdated = pgFunction("count_updated", {
  returns: "trigger",
  language: "plpgsql",
  body: "BEGIN\\n  INSERT INTO ledger_audit (kind, n) SELECT 'update', count(*)::integer FROM old_rows;\\n  RETURN NULL;\\nEND;",
});

export const ledgerUpdated = pgTrigger("ledger_updated", {
  table: ledger,
  timing: "after",
  events: ["update"],
  referencing: { oldTable: "old_rows", newTable: "new_rows" },
  function: countUpdated,
});

export const touchEmail = pgFunction("touch_email", {
  returns: "trigger",
  language: "plpgsql",
  body: "BEGIN\\n  NEW.touches = NEW.touches + 1;\\n  RETURN NEW;\\nEND;",
});

export const profilesEmail = pgTrigger("profiles_email", {
  table: profiles,
  timing: "before",
  events: ["update"],
  columns: [profiles.email],
  when: ({ OLD, NEW }) => sql\`\${OLD.email} IS DISTINCT FROM \${NEW.email}\`,
  function: touchEmail,
});

export const raiseAlways = pgFunction("raise_always", {
  returns: "trigger",
  language: "plpgsql",
  body: "BEGIN\\n  RAISE EXCEPTION 'disabled trigger fired';\\nEND;",
});

export const profilesGuard = pgTrigger("profiles_guard", {
  table: profiles,
  timing: "before",
  events: ["delete"],
  function: raiseAlways,
  enabled: ${options.enabled},
});

export const insertProfile = pgFunction("insert_profile", {
  returns: "trigger",
  language: "plpgsql",
  body: "BEGIN\\n  INSERT INTO profiles (email, name) VALUES (NEW.email, 'from view');\\n  RETURN NEW;\\nEND;",
});

export const profileEmailsInsert = pgTrigger("profile_emails_insert", {
  table: profileEmails,
  timing: "instead of",
  events: ["insert"],
  function: insertProfile,
});
`;
}

describe.skipIf(!url)("postgres triggers", () => {
  it("applies constraint, transition, instead-of, when, and enable changes on postgres", async () => {
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "pg-trigger-"));
    writeFileSync(path.join(dir, "schema.ts"), schemaSource({ initially: "deferred", enabled: false }));
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
      await client.query("GRANT ALL ON SCHEMA public TO public");

      const table = kitExec(dir, ["generate", "--name", "tables", "--config", "drizzle.config.ts"]);
      expect(table.status, table.stderr + table.stdout).toBe(0);

      process.chdir(dir);
      expect(await run(["generate", "--name", "triggers"])).toBe(0);
      process.chdir(cwd);

      const migrate = kitExec(dir, ["migrate", "--config", "drizzle.config.ts"]);
      expect(migrate.status, migrate.stderr + migrate.stdout).toBe(0);

      const upSql = readFileSync(path.join(dir, "drizzle", "0001_triggers.sql"), "utf8");
      expect(upSql).toContain("CREATE CONSTRAINT TRIGGER");
      expect(upSql).toContain("DEFERRABLE INITIALLY DEFERRED");
      expect(upSql).toContain('FROM "public"."customers"');
      expect(upSql).toContain('UPDATE OF "amount"');
      expect(upSql).toContain('REFERENCING NEW TABLE AS "inserted"');
      expect(upSql).toContain('REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"');
      expect(upSql).toContain("INSTEAD OF INSERT");
      expect(upSql).toContain('WHEN (OLD."email" IS DISTINCT FROM NEW."email")');
      expect(upSql).toContain('DISABLE TRIGGER "profiles_guard"');
      await runStatements(client, upSql);

      await client.query("INSERT INTO balances (customer_id, amount) VALUES (1, 5)");
      await client.query("BEGIN");
      await client.query("INSERT INTO balances (customer_id, amount) VALUES (1, -1)");
      await expect(client.query("COMMIT")).rejects.toThrow(/negative balance/);
      await client.query("ROLLBACK").catch(() => undefined);
      const kept = await client.query<{ amount: number }>("SELECT amount FROM balances ORDER BY id");
      expect(kept.rows.map((row) => row.amount)).toEqual([5]);

      await client.query("INSERT INTO ledger (amount) VALUES (1), (2), (3)");
      await client.query("UPDATE ledger SET amount = amount + 1");
      const audit = await client.query<{ kind: string; n: number }>("SELECT kind, n FROM ledger_audit ORDER BY id");
      expect(audit.rows).toEqual([
        { kind: "insert", n: 3 },
        { kind: "update", n: 3 },
        { kind: "update", n: 3 },
        { kind: "update", n: 3 },
      ]);

      const profile = await client.query<{ id: number }>("INSERT INTO profiles (email, name) VALUES ('a@a.com', 'a') RETURNING id");
      const profileId = profile.rows[0]!.id;
      await client.query("UPDATE profiles SET name = 'b' WHERE id = $1", [profileId]);
      await client.query("UPDATE profiles SET email = 'a@a.com' WHERE id = $1", [profileId]);
      await client.query("UPDATE profiles SET email = 'b@b.com' WHERE id = $1", [profileId]);
      const touches = await client.query<{ touches: number }>("SELECT touches FROM profiles WHERE id = $1", [profileId]);
      expect(touches.rows[0]!.touches).toBe(1);

      await client.query("INSERT INTO profile_emails (email) VALUES ('view@a.com')");
      const fromView = await client.query<{ name: string }>("SELECT name FROM profiles WHERE email = 'view@a.com'");
      expect(fromView.rows[0]!.name).toBe("from view");
      await client.query("DELETE FROM profiles WHERE email = 'view@a.com'");

      const catalog = await triggerCatalog(client);
      expect(catalog.get("balances_amount")).toMatchObject({
        deferrable: true,
        deferred: true,
        enabled: "O",
        fromTable: "customers",
        comment: "non-negative",
      });
      expect(catalog.get("balances_amount")!.def).toContain("UPDATE OF amount");
      expect(catalog.get("profiles_guard")?.enabled).toBe("D");
      expect(catalog.get("profile_emails_insert")?.def).toContain("INSTEAD OF INSERT");

      const beforeKit = sqlFiles(path.join(dir, "drizzle"));
      const noop = kitExec(dir, ["generate", "--name", "noop", "--config", "drizzle.config.ts"]);
      expect(noop.status, noop.stderr + noop.stdout).toBe(0);
      expect(noop.stdout).toContain("No schema changes");
      expect(sqlFiles(path.join(dir, "drizzle"))).toEqual(beforeKit);

      writeFileSync(path.join(dir, "schema.ts"), schemaSource({ initially: "immediate", enabled: true }));
      process.chdir(dir);
      expect(await run(["generate", "--name", "tighten"])).toBe(0);
      process.chdir(cwd);
      const changed = readFileSync(path.join(dir, "drizzle", "0002_tighten.sql"), "utf8");
      expect(changed).toContain("DEFERRABLE INITIALLY IMMEDIATE");
      expect(changed).toContain('ENABLE TRIGGER "profiles_guard"');
      expect(changed).not.toContain("ledger_inserted");
      await runStatements(client, changed);
      await runStatements(client, changed);

      await expect(client.query("INSERT INTO balances (customer_id, amount) VALUES (1, -1)")).rejects.toThrow(/negative balance/);
      await expect(client.query("DELETE FROM profiles WHERE id = $1", [profileId])).rejects.toThrow(/disabled trigger fired/);
      const after = await triggerCatalog(client);
      expect(after.get("balances_amount")).toMatchObject({
        deferrable: true,
        deferred: false,
        comment: "non-negative",
      });
      expect(after.get("profiles_guard")?.enabled).toBe("O");

      const again = kitExec(dir, ["generate", "--name", "noop2", "--config", "drizzle.config.ts"]);
      expect(again.status, again.stderr + again.stdout).toBe(0);
      expect(again.stdout).toContain("No schema changes");
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

async function triggerCatalog(client: pg.Client): Promise<Map<string, {
  enabled: string;
  deferrable: boolean;
  deferred: boolean;
  fromTable: string | null;
  comment: string | null;
  def: string;
}>> {
  const result = await client.query<{
    tgname: string;
    tgenabled: string;
    tgdeferrable: boolean;
    tginitdeferred: boolean;
    comment: string | null;
    from_table: string | null;
    def: string;
  }>(`SELECT t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred,
             obj_description(t.oid, 'pg_trigger') AS comment,
             c.relname AS from_table,
             pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class rel ON rel.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      LEFT JOIN pg_class c ON c.oid = t.tgconstrrelid
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
  return new Map(result.rows.map((row) => [row.tgname, {
    enabled: row.tgenabled,
    deferrable: row.tgdeferrable,
    deferred: row.tginitdeferred,
    fromTable: row.from_table,
    comment: row.comment,
    def: row.def,
  }]));
}

function sqlFiles(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql")).sort();
}

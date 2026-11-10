import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { integer, pgSchema, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import {
  commentOn,
  defineExtras,
  diffSnapshots,
  emptySnapshot,
  generate,
  pgExtension,
  pgFunction,
  pgTrigger,
  snapshotExtras,
  updatedAtTrigger,
  withComment,
} from "../../src/index.js";

const auth = pgSchema("auth");

function appSchema() {
  const users = withComment(
    pgTable("users", {
      id: integer("id").primaryKey(),
      email: withComment(text("email").notNull(), "Login email"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    }),
    "Application users",
  );
  const touch = pgFunction("set_updated_at", {
    returns: "trigger",
    language: "plpgsql",
    security: "definer",
    searchPath: [],
    body: "BEGIN\n  NEW.updated_at = now();\n  RETURN NEW;\nEND;",
  });
  const usersTouch = pgTrigger("users_set_updated_at", {
    table: users,
    timing: "before",
    events: ["update"],
    columns: [users.email],
    when: ({ OLD, NEW }) => sql`${OLD.email} IS DISTINCT FROM ${NEW.email}`,
    function: touch,
  });
  const add = pgFunction("add_one", {
    args: [{ name: "n", type: "integer", default: "0" }],
    returns: users.id,
    language: "sql",
    volatility: "immutable",
    body: sql`SELECT n + 1`,
  });
  return defineExtras({
    functions: [touch, add],
    triggers: [usersTouch],
    extensions: [pgExtension("pgcrypto"), pgExtension("vector", { schema: "extensions", cascade: true })],
    tables: [users],
  });
}

describe("sql generation", () => {
  it("emits idempotent statements for a first snapshot", () => {
    const diff = diffSnapshots(emptySnapshot(), snapshotExtras(appSchema()));
    const up = diff.up.join("\n");
    expect(up).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
    expect(up).toContain('CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "extensions" CASCADE;');
    expect(up).toContain('CREATE OR REPLACE FUNCTION "public"."set_updated_at"()');
    expect(up).toContain("RETURNS trigger");
    expect(up).toContain("LANGUAGE plpgsql");
    expect(up).toContain("SECURITY DEFINER");
    expect(up).toContain("SET search_path TO ''");
    expect(up).toContain('CREATE OR REPLACE FUNCTION "public"."add_one"("n" integer DEFAULT 0)');
    expect(up).toContain("LANGUAGE sql");
    expect(up).toContain("IMMUTABLE");
    expect(up).toContain("SET check_function_bodies = off");
    expect(up).toContain("SET check_function_bodies = on");
    expect(up).toContain('COMMENT ON TABLE "public"."users" IS \'Application users\';');
    expect(up).toContain('COMMENT ON COLUMN "public"."users"."email" IS \'Login email\';');
    expect(up).toContain('CREATE OR REPLACE TRIGGER "users_set_updated_at"');
    expect(up).toContain('BEFORE UPDATE OF "email" ON "public"."users"');
    expect(up).toContain('WHEN (OLD."email" IS DISTINCT FROM NEW."email")');
    expect(up).toContain('EXECUTE FUNCTION "public"."set_updated_at"();');
    expect(diff.down.join("\n")).toContain('DROP TRIGGER IF EXISTS "users_set_updated_at" ON "public"."users";');
    expect(diff.down.join("\n")).toContain('DROP FUNCTION IF EXISTS "public"."set_updated_at"();');
    expect(diff.down.join("\n")).toContain('DROP EXTENSION IF EXISTS "vector" CASCADE;');
    expect(diff.down.join("\n")).toContain('COMMENT ON TABLE "public"."users" IS NULL;');
  });

  it("emits nothing when the snapshot is unchanged", () => {
    const snap = snapshotExtras(appSchema());
    expect(diffSnapshots(snap, snapshotExtras(appSchema())).up).toEqual([]);
  });

  it("replaces a function body without dropping its trigger", () => {
    const users = pgTable("users", { id: integer("id").primaryKey() });
    const beforeFn = pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NEW; END;" });
    const afterFn = pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NULL; END;" });
    const before = snapshotExtras(defineExtras({
      functions: [beforeFn],
      triggers: [pgTrigger("users_touch", { table: users, timing: "before", events: ["update"], function: beforeFn })],
      tables: [users],
    }));
    const after = snapshotExtras(defineExtras({
      functions: [afterFn],
      triggers: [pgTrigger("users_touch", { table: users, timing: "before", events: ["update"], function: afterFn })],
      tables: [users],
    }));
    const up = diffSnapshots(before, after).up;
    expect(up.some((statement) => statement.startsWith("DROP TRIGGER"))).toBe(false);
    expect(up.some((statement) => statement.startsWith("DROP FUNCTION"))).toBe(false);
    expect(up.join("\n")).toContain("RETURN NULL");
    expect(diffSnapshots(after, before).up.join("\n")).toContain("RETURN NEW");
  });

  it("drops and recreates a function when its return type changes, and recreates dependent triggers", () => {
    const users = pgTable("users", { id: integer("id").primaryKey() });
    const beforeFn = pgFunction("touch", { returns: "trigger", args: [], body: "BEGIN RETURN NEW; END;" });
    const afterFn = pgFunction("touch", {
      returns: "trigger",
      args: [{ name: "flag", type: "integer" }],
      body: "BEGIN RETURN NEW; END;",
    });
    const before = snapshotExtras(defineExtras({
      functions: [beforeFn],
      triggers: [pgTrigger("users_touch", { table: users, timing: "after", events: ["insert"], function: beforeFn })],
      tables: [users],
    }));
    const after = snapshotExtras(defineExtras({
      functions: [afterFn],
      triggers: [pgTrigger("users_touch", { table: users, timing: "after", events: ["insert"], function: afterFn, args: [1] })],
      tables: [users],
    }));
    const up = diffSnapshots(before, after).up;
    expect(up[0]).toMatch(/^DROP TRIGGER IF EXISTS/);
    expect(up[1]).toContain('DROP FUNCTION IF EXISTS "public"."touch"()');
    expect(up[2]).toContain('"flag" integer');
    expect(up[3]).toMatch(/^CREATE OR REPLACE TRIGGER/);
    expect(up[3]).toContain('EXECUTE FUNCTION "public"."touch"(1);');
    expect(up).toHaveLength(4);
  });

  it("changes only the comment that changed and clears one that was removed", () => {
    const beforeTable = withComment(
      pgTable("users", {
        email: withComment(text("email").notNull(), "old"),
        name: withComment(text("name").notNull(), "name"),
      }),
      "Users",
    );
    const afterTable = withComment(
      pgTable("users", {
        email: withComment(text("email").notNull(), "new"),
        name: text("name").notNull(),
      }),
      "Users",
    );
    const up = diffSnapshots(
      snapshotExtras(defineExtras({ tables: [beforeTable] })),
      snapshotExtras(defineExtras({ tables: [afterTable] })),
    ).up;
    expect(up).toEqual([
      `COMMENT ON COLUMN "public"."users"."email" IS 'new';`,
      `COMMENT ON COLUMN "public"."users"."name" IS NULL;`,
    ]);
  });

  it("escapes quotes in comments and picks a dollar-quote tag that is not in the body", () => {
    const users = pgTable("users", { id: integer("id").primaryKey() });
    const fn = pgFunction("odd", {
      returns: "void",
      language: "sql",
      body: "SELECT '$function$'",
    });
    const up = diffSnapshots(
      snapshotExtras(defineExtras({ tables: [] })),
      snapshotExtras(defineExtras({
        functions: [fn],
        comments: [commentOn(users, "it's a table")],
        tables: [users],
      })),
    ).up.join("\n");
    expect(up).toContain(`IS 'it''s a table';`);
    expect(up).toContain("AS $function1$\nSELECT '$function$'\n$function1$;");
  });

  it("skips drops for a table or column that left the schema", () => {
    const before = withComment(
      pgTable("users", { email: withComment(text("email"), "email") }),
      "Users",
    );
    const kept = pgTable("kept", { id: integer("id").primaryKey() });
    const triggerFn = pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NEW; END;" });
    const previous = snapshotExtras(defineExtras({
      tables: [before],
      functions: [triggerFn],
      triggers: [pgTrigger("users_touch", { table: before, timing: "before", events: ["delete"], function: triggerFn })],
    }));
    const next = snapshotExtras(defineExtras({ tables: [kept] }));
    expect(diffSnapshots(previous, next).up.join("\n")).not.toContain("users");
    expect(diffSnapshots(previous, next).up.join("\n")).toContain('DROP FUNCTION IF EXISTS "public"."touch"()');
  });

  it("moves an extension schema and drops one that was removed", () => {
    const previous = snapshotExtras(defineExtras({ extensions: [pgExtension("vector", { schema: "public" })] }));
    const next = snapshotExtras(defineExtras({ extensions: [pgExtension("vector", { schema: "extensions", version: "0.8.0" })] }));
    expect(diffSnapshots(previous, next).up).toEqual([
      'ALTER EXTENSION "vector" SET SCHEMA "extensions";',
      `ALTER EXTENSION "vector" UPDATE TO '0.8.0';`,
    ]);
    expect(diffSnapshots(next, snapshotExtras(defineExtras({ extensions: [] }))).up).toEqual([
      'DROP EXTENSION IF EXISTS "vector";',
    ]);
  });

  it("renders schema-qualified tables inside a function body", () => {
    const accounts = auth.table("accounts", { id: integer("id").primaryKey() });
    const fn = pgFunction("count_accounts", {
      schema: "auth",
      returns: "integer",
      language: "sql",
      body: sql`SELECT count(*)::integer FROM ${accounts}`,
    });
    const up = diffSnapshots(
      snapshotExtras(defineExtras({})),
      snapshotExtras(defineExtras({ functions: [fn] })),
    ).up.join("\n");
    expect(up).toContain('CREATE OR REPLACE FUNCTION "auth"."count_accounts"()');
    expect(up).toContain('SELECT count(*)::integer FROM "auth"."accounts"');
  });

  it("builds an updatedAt trigger from the column's database name", () => {
    const posts = pgTable("posts", {
      updatedAt: timestamp().notNull(),
    });
    const snap = snapshotExtras(
      defineExtras({ tables: [posts], triggers: [updatedAtTrigger(posts, posts.updatedAt)] }),
      { casing: "snake_case" },
    );
    const up = diffSnapshots(snapshotExtras(defineExtras({})), snap).up.join("\n");
    expect(up).toContain('CREATE OR REPLACE FUNCTION "public"."set_updated_at"()');
    expect(up).toContain('NEW."updated_at" = now();');
    expect(up).toContain('CREATE OR REPLACE TRIGGER "posts_set_updated_at"');
    expect(up).toContain('BEFORE UPDATE ON "public"."posts"');
  });

  it("shares one updatedAt function across tables with the same column name", () => {
    const a = pgTable("a", { updatedAt: timestamp("updated_at").notNull() });
    const b = pgTable("b", { updatedAt: timestamp("updated_at").notNull() });
    const snap = snapshotExtras(defineExtras({
      tables: [a, b],
      triggers: [updatedAtTrigger(a, a.updatedAt), updatedAtTrigger(b, b.updatedAt)],
    }));
    expect(snap.functions).toHaveLength(1);
    expect(snap.triggers.map((trigger) => trigger.name).sort()).toEqual(["a_set_updated_at", "b_set_updated_at"]);
  });
});

describe("definition checks", () => {
  const users = pgTable("users", { id: integer("id").primaryKey(), email: text("email") });
  const other = pgTable("other", { id: integer("id").primaryKey() });

  it("rejects a column from another table, truncate-for-each-row, and a non-trigger function", () => {
    expect(() =>
      pgTrigger("t", {
        table: users,
        timing: "before",
        events: ["update"],
        columns: [other.id] as never,
        function: { name: "f" },
      }),
    ).toThrow(/does not belong/);
    expect(() => pgTrigger("t", { table: users, timing: "before", events: ["truncate"], function: { name: "f" } })).toThrow(/statement/);
    const fn = pgFunction("not_trigger", { returns: "integer", language: "sql", body: "SELECT 1" });
    expect(() => pgTrigger("t", { table: users, timing: "before", events: ["update"], function: fn })).toThrow(/not trigger/);
    expect(() => updatedAtTrigger(users, users.email)).toThrow(/date, time, or timestamp/);
    expect(() => pgTrigger("t", { table: users, timing: "instead of" as "before", events: ["update"], function: { name: "f" } })).toThrow(/INSTEAD OF/);
  });
});

describe("migration files", () => {
  it("appends a journal entry and a kit snapshot drizzle can read", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pg-extras-"));
    const extras = defineExtras({ extensions: [pgExtension("pgcrypto")] });
    const first = generate({ extras, out: dir, name: "Add pgcrypto" });
    expect(first.written).toBe(true);
    if (!first.written) return;
    expect(first.tag).toBe("0000_add_pgcrypto");
    const sql = readFileSync(first.sqlPath, "utf8");
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
    expect(sql).not.toContain("--> statement-breakpoint\n-->");
    const migrations = readMigrationFiles({ migrationsFolder: dir });
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.sql[0]).toContain("CREATE EXTENSION");
    const journal = JSON.parse(readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; breakpoints: boolean }[] };
    expect(journal.entries.map((entry) => entry.tag)).toEqual(["0000_add_pgcrypto"]);
    const snapshot = JSON.parse(readFileSync(path.join(dir, "meta", "0000_snapshot.json"), "utf8")) as { id: string; prevId: string; tables: object };
    expect(snapshot.prevId).toBe("00000000-0000-0000-0000-000000000000");
    expect(snapshot.tables).toEqual({});
    expect(readdirSync(path.join(dir, "meta")).some((file) => file.startsWith("_pg-extras"))).toBe(false);
    expect(readFileSync(path.join(dir, "_pg-extras.json"), "utf8")).toContain("pgcrypto");

    const second = generate({ extras, out: dir, name: "again" });
    expect(second.written).toBe(false);

    const changed = generate({
      extras: defineExtras({ extensions: [pgExtension("pgcrypto"), pgExtension("citext")] }),
      out: dir,
      name: "citext",
    });
    expect(changed.written).toBe(true);
    if (!changed.written) return;
    const next = JSON.parse(readFileSync(path.join(dir, "meta", "0001_snapshot.json"), "utf8")) as { prevId: string };
    expect(next.prevId).toBe(snapshot.id);
    const up = readFileSync(changed.sqlPath, "utf8");
    expect(up).toContain('CREATE EXTENSION IF NOT EXISTS "citext";');
    expect(up).not.toContain("pgcrypto");
  });

  it("writes a v1 folder without creating a journal", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pg-extras-v1-"));
    const folder = path.join(dir, "20260101010101_init");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "migration.sql"), "-- table\n");
    writeFileSync(path.join(folder, "snapshot.json"), JSON.stringify({ id: "prev-id", prevId: "00000000-0000-0000-0000-000000000000", tables: { keep: true } }));
    const result = generate({ extras: defineExtras({ extensions: [pgExtension("pgcrypto")] }), out: dir, name: "ext" });
    expect(result.written).toBe(true);
    if (!result.written) return;
    expect(result.layout).toBe("v1");
    expect(readFileSync(result.sqlPath, "utf8")).toContain("pgcrypto");
    const copied = JSON.parse(readFileSync(path.join(path.dirname(result.sqlPath), "snapshot.json"), "utf8")) as { id: string; prevId: string; tables: { keep: boolean } };
    expect(copied.prevId).toBe("prev-id");
    expect(copied.id).not.toBe("prev-id");
    expect(copied.tables.keep).toBe(true);
    expect(readdirSync(dir).some((entry) => entry === "meta")).toBe(false);
  });
});

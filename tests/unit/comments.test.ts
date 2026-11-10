import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgMaterializedView,
  pgSchema,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  commentOn,
  defineExtras,
  diffSnapshots,
  emptySnapshot,
  parseSnapshot,
  pgExtension,
  pgFunction,
  pgTrigger,
  renderIdempotent,
  snapshotExtras,
  withComment,
} from "../../src/index.js";

const auth = pgSchema("auth");

describe("object comments", () => {
  it("emits comment statements for enums, views, functions, triggers, indexes, constraints, and extensions", () => {
    const role = withComment(auth.enum("role", ["admin", "member"]), "Membership");
    const orgs = pgTable("orgs", { id: integer("id").primaryKey() });
    const users = pgTable("users", {
      id: integer("id").primaryKey(),
      email: text("email").notNull(),
      orgId: integer("org_id").notNull(),
    }, (table) => [
      withComment(index("users_email_idx").on(table.email), "Lookup by email"),
      withComment(unique("users_email_key").on(table.email), "One email"),
      withComment(check("users_org_positive", sql`${table.orgId} > 0`), "Org id is positive"),
      withComment(foreignKey({
        name: "users_org_fk",
        columns: [table.orgId],
        foreignColumns: [orgs.id],
      }).onDelete("cascade"), "Employer"),
    ]);
    const memberships = pgTable("memberships", {
      userId: integer("user_id").notNull(),
      orgId: integer("org_id").notNull(),
    }, (table) => [
      withComment(primaryKey({ name: "memberships_pk", columns: [table.userId, table.orgId] }), "Membership key"),
    ]);
    const active = withComment(
      pgView("active_users", {
        email: withComment(text("email"), "Visible email"),
      }).as(sql`select email from users`),
      "Visible users",
    );
    const stats = withComment(
      pgMaterializedView("user_stats", { id: integer("id") }).as(sql`select id from users`),
      "One row per user",
    );
    const touch = withComment(pgFunction("set_updated_at", {
      returns: "trigger",
      body: "BEGIN RETURN NEW; END;",
    }), "Sets updated_at");
    const add = withComment(pgFunction("add_one", {
      args: [{ name: "n", type: "integer" }],
      returns: "integer",
      language: "sql",
      body: sql`select n + 1`,
    }), "Adds one");
    const usersTouch = withComment(pgTrigger("users_touch", {
      table: users,
      timing: "before",
      events: ["update"],
      function: touch,
    }), "Keeps updated_at current");
    const crypto = withComment(pgExtension("pgcrypto"), "Cryptographic functions");

    const up = diffSnapshots(emptySnapshot(), snapshotExtras(defineExtras({
      enums: [role],
      tables: [orgs, users, memberships],
      views: [active, stats],
      functions: [touch, add],
      triggers: [usersTouch],
      extensions: [crypto],
    }))).up;
    const sqlText = up.join("\n");
    expect(sqlText).toContain(`COMMENT ON TYPE "auth"."role" IS 'Membership';`);
    expect(sqlText).toContain(`COMMENT ON VIEW "public"."active_users" IS 'Visible users';`);
    expect(sqlText).toContain(`COMMENT ON COLUMN "public"."active_users"."email" IS 'Visible email';`);
    expect(sqlText).toContain(`COMMENT ON MATERIALIZED VIEW "public"."user_stats" IS 'One row per user';`);
    expect(sqlText).toContain(`COMMENT ON FUNCTION "public"."set_updated_at"() IS 'Sets updated_at';`);
    expect(sqlText).toContain(`COMMENT ON FUNCTION "public"."add_one"(integer) IS 'Adds one';`);
    expect(sqlText).toContain(`COMMENT ON TRIGGER "users_touch" ON "public"."users" IS 'Keeps updated_at current';`);
    expect(sqlText).toContain(`COMMENT ON INDEX "public"."users_email_idx" IS 'Lookup by email';`);
    expect(sqlText).toContain(`COMMENT ON CONSTRAINT "users_email_key" ON "public"."users" IS 'One email';`);
    expect(sqlText).toContain(`COMMENT ON CONSTRAINT "users_org_positive" ON "public"."users" IS 'Org id is positive';`);
    expect(sqlText).toContain(`COMMENT ON CONSTRAINT "users_org_fk" ON "public"."users" IS 'Employer';`);
    expect(sqlText).toContain(`COMMENT ON CONSTRAINT "memberships_pk" ON "public"."memberships" IS 'Membership key';`);
    expect(sqlText).toContain(`COMMENT ON EXTENSION "pgcrypto" IS 'Cryptographic functions';`);
    expect(sqlText.indexOf("CREATE EXTENSION")).toBeLessThan(sqlText.indexOf("COMMENT ON EXTENSION"));
    expect(sqlText.indexOf('CREATE OR REPLACE FUNCTION "public"."set_updated_at"()')).toBeLessThan(
      sqlText.indexOf('COMMENT ON FUNCTION "public"."set_updated_at"()'),
    );
    expect(sqlText.indexOf('CREATE OR REPLACE TRIGGER "users_touch"')).toBeLessThan(
      sqlText.indexOf('COMMENT ON TRIGGER "users_touch"'),
    );
    expect(diffSnapshots(
      snapshotExtras(defineExtras({ enums: [role], tables: [users], views: [active], functions: [touch], triggers: [usersTouch], extensions: [crypto] })),
      snapshotExtras(defineExtras({ enums: [role], tables: [users], views: [active], functions: [touch], triggers: [usersTouch], extensions: [crypto] })),
    ).up).toEqual([]);
  });

  it("names an unnamed index the way drizzle-kit does, including snake_case keys", () => {
    const posts = pgTable("posts", {
      updatedAt: timestamp().notNull(),
    }, (table) => [
      withComment(index().on(table.updatedAt), "By update time"),
    ]);
    const up = diffSnapshots(emptySnapshot(), snapshotExtras(defineExtras({ tables: [posts] }), { casing: "snake_case" })).up.join("\n");
    expect(up).toContain(`COMMENT ON INDEX "public"."posts_updated_at_index" IS 'By update time';`);
  });

  it("requires a name when an index expression is SQL", () => {
    const users = pgTable("users", {
      email: text("email").notNull(),
    }, (table) => [
      withComment(index().on(sql`lower(${table.email})`), "Case-insensitive email"),
    ]);
    expect(() => snapshotExtras(defineExtras({ tables: [users] }))).toThrow(/index name/);
    const named = pgTable("users", {
      email: text("email").notNull(),
    }, (table) => [
      withComment(index("users_email_lower").on(sql`lower(${table.email})`), "Case-insensitive email"),
    ]);
    const up = diffSnapshots(emptySnapshot(), snapshotExtras(defineExtras({ tables: [named] }))).up.join("\n");
    expect(up).toContain(`COMMENT ON INDEX "public"."users_email_lower" IS 'Case-insensitive email';`);
  });

  it("changes one comment and clears the ones that were removed", () => {
    const beforeRole = withComment(pgEnum("role", ["admin"]), "old");
    const afterRole = withComment(pgEnum("role", ["admin"]), "new");
    const beforeFn = withComment(pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NEW; END;" }), "touches");
    const afterFn = pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NEW; END;" });
    const before = pgTable("users", {
      email: text("email").notNull(),
    }, (table) => [
      withComment(index("users_email_idx").on(table.email), "lookup"),
    ]);
    const after = pgTable("users", {
      email: text("email").notNull(),
    }, (table) => [
      index("users_email_idx").on(table.email),
    ]);
    const up = diffSnapshots(
      snapshotExtras(defineExtras({ enums: [beforeRole], tables: [before], functions: [beforeFn] })),
      snapshotExtras(defineExtras({ enums: [afterRole], tables: [after], functions: [afterFn] })),
    ).up;
    expect(up).toEqual([
      `COMMENT ON TYPE "public"."role" IS 'new';`,
      `COMMENT ON FUNCTION "public"."touch"() IS NULL;`,
      `COMMENT ON INDEX "public"."users_email_idx" IS NULL;`,
    ]);
  });

  it("omits the null comment when the enum, view, or index left the schema", () => {
    const role = withComment(pgEnum("role", ["admin"]), "Role");
    const active = withComment(
      pgView("active_users", { id: integer("id") }).as(sql`select 1`),
      "Active",
    );
    const users = pgTable("users", {
      email: text("email"),
    }, (table) => [
      withComment(index("users_email_idx").on(table.email), "lookup"),
    ]);
    const kept = pgTable("kept", { id: integer("id").primaryKey() });
    const previous = snapshotExtras(defineExtras({ enums: [role], views: [active], tables: [users] }));
    const next = snapshotExtras(defineExtras({ tables: [kept] }));
    expect(diffSnapshots(previous, next).up).toEqual([]);
  });

  it("drops a function without nulling its comment, and nulls a comment that was only removed", () => {
    const fn = withComment(pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NEW; END;" }), "touches");
    const previous = snapshotExtras(defineExtras({ functions: [fn] }));
    const removed = diffSnapshots(previous, snapshotExtras(defineExtras({}))).up;
    expect(removed).toEqual(['DROP FUNCTION IF EXISTS "public"."touch"();']);
    const cleared = diffSnapshots(previous, snapshotExtras(defineExtras({
      functions: [pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NEW; END;" })],
    }))).up;
    expect(cleared).toEqual([`COMMENT ON FUNCTION "public"."touch"() IS NULL;`]);
  });

  it("reapplies a function comment when the return type change drops and recreates the function", () => {
    const before = withComment(pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NEW; END;" }), "touches");
    const after = withComment(pgFunction("touch", { returns: "void", language: "sql", body: sql`select 1` }), "touches");
    const up = diffSnapshots(
      snapshotExtras(defineExtras({ functions: [before] })),
      snapshotExtras(defineExtras({ functions: [after] })),
    ).up;
    expect(up.map((statement) => statement.split("\n")[0])).toEqual([
      'DROP FUNCTION IF EXISTS "public"."touch"();',
      'SET check_function_bodies = off',
      'CREATE OR REPLACE FUNCTION "public"."touch"()',
      'SET check_function_bodies = on',
      `COMMENT ON FUNCTION "public"."touch"() IS 'touches';`,
    ]);
  });

  it("does not null an extension comment in the same migration that drops the extension", () => {
    const ext = withComment(pgExtension("pgcrypto"), "crypto");
    const down = diffSnapshots(emptySnapshot(), snapshotExtras(defineExtras({ extensions: [ext] }))).down;
    expect(down).toEqual(['DROP EXTENSION IF EXISTS "pgcrypto";']);
  });

  it("accepts commentOn for an enum, a view, and a function", () => {
    const role = pgEnum("role", ["admin"]);
    const active = pgView("active_users", { id: integer("id") }).as(sql`select 1`);
    const touch = pgFunction("touch", { returns: "void", language: "sql", body: sql`select 1` });
    const up = diffSnapshots(emptySnapshot(), snapshotExtras(defineExtras({
      enums: [role],
      views: [active],
      functions: [touch],
      comments: [
        commentOn(role, "Role"),
        commentOn(active, "Active"),
        commentOn(touch, "Touch"),
      ],
    }))).up.join("\n");
    expect(up).toContain(`COMMENT ON TYPE "public"."role" IS 'Role';`);
    expect(up).toContain(`COMMENT ON VIEW "public"."active_users" IS 'Active';`);
    expect(up).toContain(`COMMENT ON FUNCTION "public"."touch"() IS 'Touch';`);
  });

  it("rejects a second different comment and a builder that is not finished", () => {
    const role = withComment(pgEnum("role", ["admin"]), "one");
    expect(() => snapshotExtras(defineExtras({
      enums: [role],
      comments: [commentOn(role, "two")],
    }))).toThrow(/declared twice/);
    expect(() => withComment(pgView("active_users") as never, "too soon")).toThrow(/\.as\(\)/);
    expect(() => withComment(index("users_email_idx") as never, "too soon")).toThrow(/\.on\(/);
    expect(() => commentOn(index("users_email_idx").on(sql`1`) as never, "no")).toThrow(/withComment/);
  });

  it("still clears a column comment stored by 0.2", () => {
    const previous = parseSnapshot({
      version: 1,
      comments: [{
        id: JSON.stringify(["column", "public", "users", "email"]),
        kind: "column",
        schema: "public",
        table: "users",
        column: "email",
        text: "old",
      }],
      inventory: { scanned: true, tables: [{ schema: "public", name: "users", columns: ["email"] }] },
    });
    const next = snapshotExtras(defineExtras({
      tables: [pgTable("users", { email: text("email") })],
    }));
    expect(diffSnapshots(previous, next).up).toEqual([
      `COMMENT ON COLUMN "public"."users"."email" IS NULL;`,
    ]);
  });

  it("includes every current comment in the idempotent script, after the object it names", () => {
    const touch = withComment(pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NEW; END;" }), "touches");
    const users = pgTable("users", { id: integer("id").primaryKey() });
    const trigger = withComment(pgTrigger("users_touch", {
      table: users,
      timing: "before",
      events: ["update"],
      function: touch,
    }), "Keeps updated_at current");
    const script = renderIdempotent(defineExtras({ functions: [touch], triggers: [trigger], tables: [users] }));
    expect(script.indexOf('CREATE OR REPLACE FUNCTION "public"."touch"()')).toBeLessThan(
      script.indexOf(`COMMENT ON FUNCTION "public"."touch"() IS 'touches';`),
    );
    expect(script.indexOf('CREATE OR REPLACE TRIGGER "users_touch"')).toBeLessThan(
      script.indexOf(`COMMENT ON TRIGGER "users_touch" ON "public"."users" IS 'Keeps updated_at current';`),
    );
  });
});

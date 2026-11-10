import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { index, integer, pgEnum, pgTable, pgView, serial, text, unique } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { defineExtras, generate, pgExtension, pgFunction, pgTrigger, withComment } from "../../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.tmp");
const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/drizzle-kit/bin.cjs");

describe("drizzle-kit snapshot chain", () => {
  it("keeps the next drizzle-kit generate from repeating table DDL", () => {
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "kit-"));
    writeFileSync(
      path.join(dir, "schema.ts"),
      `import { pgTable, serial, text } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
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
  dbCredentials: { url: "postgres://localhost/unused" },
});
`,
    );
    const first = spawnSync(process.execPath, [kit, "generate", "--name", "users", "--config", "drizzle.config.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(first.status, first.stderr + first.stdout).toBe(0);

    const users = pgTable("users", { id: serial("id").primaryKey(), email: text("email").notNull() });
    const fn = pgFunction("reject", { returns: "trigger", body: "BEGIN RETURN NEW; END;" });
    const written = generate({
      extras: defineExtras({
        extensions: [pgExtension("pgcrypto")],
        functions: [fn],
        triggers: [pgTrigger("users_reject", { table: users, timing: "before", events: ["insert"], function: fn })],
        tables: [users],
      }),
      out: path.join(dir, "drizzle"),
      name: "extras",
    });
    expect(written.written).toBe(true);

    const before = sqlFiles(path.join(dir, "drizzle"));
    const second = spawnSync(process.execPath, [kit, "generate", "--name", "again", "--config", "drizzle.config.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(second.stdout).toContain("No schema changes");
    expect(sqlFiles(path.join(dir, "drizzle"))).toEqual(before);
  });

  it("lets drizzle-kit ignore comments on enums, views, and indexes", () => {
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "kit-comments-"));
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");
    writeFileSync(
      path.join(dir, "schema.ts"),
      `import { sql } from "drizzle-orm";
import { index, integer, pgEnum, pgTable, pgView, text, unique } from "drizzle-orm/pg-core";
import { withComment } from ${JSON.stringify(source)};

export const role = withComment(pgEnum("user_role", ["admin", "member"]), "Account role");

export const users = withComment(pgTable("users", {
  id: integer("id").primaryKey(),
  email: text("email").notNull(),
  role: role("role").notNull(),
}, (table) => [
  withComment(index("users_email_idx").on(table.email), "Lookup by email"),
  withComment(unique("users_email_key").on(table.email), "One email"),
]), "Application users");

export const activeUsers = withComment(pgView("active_users", {
  email: text("email"),
}).as(sql\`select email from users\`), "Visible users");
`,
    );
    writeFileSync(
      path.join(dir, "drizzle.config.ts"),
      `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  out: "./drizzle",
  dbCredentials: { url: "postgres://localhost/unused" },
});
`,
    );
    const first = spawnSync(process.execPath, [kit, "generate", "--name", "users", "--config", "drizzle.config.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(first.status, first.stderr + first.stdout).toBe(0);

    const role = withComment(pgEnum("user_role", ["admin", "member"]), "Account role");
    const users = withComment(pgTable("users", {
      id: integer("id").primaryKey(),
      email: text("email").notNull(),
      role: role("role").notNull(),
    }, (table) => [
      withComment(index("users_email_idx").on(table.email), "Lookup by email"),
      withComment(unique("users_email_key").on(table.email), "One email"),
    ]), "Application users");
    const activeUsers = withComment(pgView("active_users", {
      email: text("email"),
    }).as(sql`select email from users`), "Visible users");
    const written = generate({
      extras: defineExtras({ enums: [role], tables: [users], views: [activeUsers] }),
      out: path.join(dir, "drizzle"),
      name: "comments",
    });
    expect(written.written).toBe(true);
    if (!written.written) return;

    const before = sqlFiles(path.join(dir, "drizzle"));
    const second = spawnSync(process.execPath, [kit, "generate", "--name", "again", "--config", "drizzle.config.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(second.stdout).toContain("No schema changes");
    expect(sqlFiles(path.join(dir, "drizzle"))).toEqual(before);
  });
});

function sqlFiles(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql")).sort();
}

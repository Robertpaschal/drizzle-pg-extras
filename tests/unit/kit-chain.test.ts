import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { defineExtras, generate, pgExtension, pgFunction, pgTrigger } from "../../src/index.js";

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
});

function sqlFiles(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql")).sort();
}

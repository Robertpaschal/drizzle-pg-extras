import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.tmp");

describe("cli", () => {
  it("generates from a drizzle config and checks that a second run is clean", async () => {
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "cli-"));
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");
    writeFileSync(
      path.join(dir, "schema.ts"),
      `import { pgTable, text } from "drizzle-orm/pg-core";
import { pgExtension, withComment } from ${JSON.stringify(source)};

export const pgcrypto = pgExtension("pgcrypto");
export const users = withComment(pgTable("users", {
  email: withComment(text("email").notNull(), "email"),
}), "users");
`,
    );
    writeFileSync(
      path.join(dir, "drizzle.config.ts"),
      `export default { dialect: "postgresql", schema: "./schema.ts", out: "./drizzle" };\n`,
    );
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await run(["generate", "--name", "init"])).toBe(0);
      const sql = readFileSync(path.join(dir, "drizzle", "0000_init.sql"), "utf8");
      expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
      expect(sql).toContain('COMMENT ON TABLE "public"."users" IS \'users\';');
      expect(sql).toContain('COMMENT ON COLUMN "public"."users"."email" IS \'email\';');
      expect(await run(["check"])).toBe(0);
      expect(await run(["generate"])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it("check fails when the schema changed after the last snapshot", async () => {
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "cli-"));
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");
    writeFileSync(
      path.join(dir, "schema.ts"),
      `import { pgExtension } from ${JSON.stringify(source)};
export const ext = pgExtension("pgcrypto");
`,
    );
    writeFileSync(
      path.join(dir, "drizzle.config.ts"),
      `export default { dialect: "postgresql", schema: "./schema.ts", out: "./drizzle" };\n`,
    );
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await run(["generate", "--name", "init"])).toBe(0);
      writeFileSync(
        path.join(dir, "schema.ts"),
        `import { pgExtension } from ${JSON.stringify(source)};
export const ext = pgExtension("citext");
`,
      );
      expect(await run(["check"])).toBe(1);
    } finally {
      process.chdir(cwd);
    }
  });
});

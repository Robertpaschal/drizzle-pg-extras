import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli.js";
import { KIT_MAJOR } from "../kit-version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.tmp");

describe("cli", () => {
  it.skipIf(process.platform === "win32")("runs the built CLI through an npm-style symlink", async () => {
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "cli-bin-"));
    try {
      await build({ outDir: dir, dts: false, silent: true });

      const bin = path.join(dir, "drizzle-pg-extras");
      symlinkSync(path.join(dir, "cli.js"), bin, "file");
      const result = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("drizzle-pg-extras generate | check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      // drizzle-kit 1.0 projects get a folder per migration; 0.x projects get the journal layout.
      const out = path.join(dir, "drizzle");
      const sqlFile =
        KIT_MAJOR >= 1
          ? path.join(out, readdirSync(out).find((entry) => entry.endsWith("_init"))!, "migration.sql")
          : path.join(out, "0000_init.sql");
      const sql = readFileSync(sqlFile, "utf8");
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

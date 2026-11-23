import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kitDir = fileURLToPath(new URL("../node_modules/drizzle-kit/", import.meta.url));
const kitPackage = JSON.parse(readFileSync(path.join(kitDir, "package.json"), "utf8")) as {
  version: string;
  bin: { "drizzle-kit": string };
};

export const KIT_BIN = path.resolve(kitDir, kitPackage.bin["drizzle-kit"]);

/** Major version of the drizzle-kit installed for this test run (0 for 0.x, 1 for 1.0). */
export const KIT_MAJOR = Number.parseInt(kitPackage.version, 10);

/**
 * Path to a generated migration's up or down SQL, for either layout:
 * `NNNN_name.sql` / `NNNN_name.down.sql` (journal, drizzle-kit 0.x) or
 * `<stamp>_name/migration.sql` / `down.sql` (folder per migration, drizzle-kit 1.0).
 */
export function migrationFile(out: string, name: string, kind: "up" | "down" = "up"): string {
  const entries = readdirSync(out).sort();
  const folder = entries.find((entry) => /^\d{14}_/.test(entry) && entry.endsWith(`_${name}`));
  if (folder) return path.join(out, folder, kind === "up" ? "migration.sql" : "down.sql");
  const suffix = kind === "up" ? `_${name}.sql` : `_${name}.down.sql`;
  const file = entries.find((entry) => /^\d+_/.test(entry) && entry.endsWith(suffix));
  if (!file) throw new Error(`no ${kind} migration named ${name} in ${out}`);
  return path.join(out, file);
}

/** Every migration in a folder, by tag, for either layout. */
export function migrationTags(out: string): string[] {
  return readdirSync(out)
    .filter((entry) => (entry.endsWith(".sql") && !entry.endsWith(".down.sql")) || /^\d{14}_/.test(entry))
    .map((entry) => entry.replace(/\.sql$/, ""))
    .sort();
}

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Casing } from "drizzle-orm";
import { collectExtras } from "./collect.js";
import type { PgExtras } from "./defs.js";
import { PgExtrasError } from "./errors.js";
import type { MigrationPrefix } from "./journal.js";

export type LoadedProject = {
  extras: PgExtras;
  out: string;
  casing?: Casing;
  prefix: MigrationPrefix;
  breakpoints: boolean;
  configPath: string;
};

export type KitConfigShape = {
  dialect?: string;
  schema?: string | string[];
  out?: string;
  casing?: Casing;
  breakpoints?: boolean;
  migrations?: { prefix?: MigrationPrefix };
};

const CONFIG_CANDIDATES = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.cjs"];
const SCHEMA_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

export async function loadProject(cwd: string, configPath?: string): Promise<LoadedProject> {
  const resolved = resolveConfigPath(cwd, configPath);
  const config = await importConfig(resolved);
  if (config.dialect && config.dialect !== "postgresql") {
    throw new PgExtrasError(
      `drizzle-pg-extras supports postgresql only. ${resolved} sets dialect "${config.dialect}".`,
    );
  }
  const schema = config.schema;
  if (!schema || (Array.isArray(schema) && schema.length === 0)) {
    throw new PgExtrasError(`${resolved} has no schema path. Set schema in the drizzle config.`);
  }
  const patterns = Array.isArray(schema) ? schema : [schema];
  const configDir = path.dirname(resolved);
  const files = expandSchemaPaths(patterns, configDir);
  const modules: Record<string, unknown>[] = [];
  for (const file of files) modules.push(await importSchema(file));
  return {
    extras: collectExtras(modules),
    out: path.resolve(configDir, config.out ?? "drizzle"),
    casing: config.casing,
    prefix: config.migrations?.prefix ?? "index",
    breakpoints: config.breakpoints ?? true,
    configPath: resolved,
  };
}

export function resolveConfigPath(cwd: string, configPath?: string): string {
  if (configPath) {
    const resolved = path.resolve(cwd, configPath);
    if (!existsSync(resolved)) throw new PgExtrasError(`config not found: ${resolved}`);
    return resolved;
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const resolved = path.join(cwd, candidate);
    if (existsSync(resolved)) return resolved;
  }
  throw new PgExtrasError("could not find drizzle.config.ts. Pass --config, or create one with dialect, schema, and out.");
}

export function expandSchemaPaths(patterns: readonly string[], cwd: string): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      const abs = path.resolve(cwd, pattern);
      if (!existsSync(abs)) throw new PgExtrasError(`schema path not found: ${pattern}`);
      if (statSync(abs).isDirectory()) found.push(...walkSchemaFiles(abs));
      else found.push(abs);
      continue;
    }
    const absPattern = path.isAbsolute(pattern) ? pattern : path.resolve(cwd, pattern);
    const star = absPattern.indexOf("*");
    const slash = absPattern.lastIndexOf("/", star);
    const base = slash === -1 ? cwd : absPattern.slice(0, slash);
    if (!existsSync(base)) throw new PgExtrasError(`schema path not found: ${pattern}`);
    const regex = globToRegExp(absPattern);
    const matches = walkSchemaFiles(base).filter((file) => regex.test(file));
    if (matches.length === 0) throw new PgExtrasError(`schema pattern matched no files: ${pattern}`);
    found.push(...matches);
  }
  return [...new Set(found)].sort();
}

function walkSchemaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSchemaFiles(full));
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".d.ts")) continue;
    if (SCHEMA_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function globToRegExp(absPattern: string): RegExp {
  let source = "";
  for (let i = 0; i < absPattern.length; i++) {
    const char = absPattern[i]!;
    if (char === "*" && absPattern[i + 1] === "*") {
      source += ".*";
      i += 1;
      if (absPattern[i + 1] === "/") i += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += "\\^$+?.()|[]{}".includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}

async function importConfig(file: string): Promise<KitConfigShape> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
  const imported = (await jiti.import(file)) as { default?: KitConfigShape } | KitConfigShape;
  const config =
    imported && typeof imported === "object" && "default" in imported && imported.default ? imported.default : imported;
  if (!config || typeof config !== "object") throw new PgExtrasError(`${file} did not export a config object`);
  return config as KitConfigShape;
}

async function importSchema(file: string): Promise<Record<string, unknown>> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
  const imported = (await jiti.import(file)) as Record<string, unknown>;
  if (!imported || typeof imported !== "object") throw new PgExtrasError(`${file} did not export a module`);
  const merged: Record<string, unknown> = { ...imported };
  const def = imported.default;
  if (def && typeof def === "object") Object.assign(merged, def as Record<string, unknown>);
  return merged;
}

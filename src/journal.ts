import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PgExtrasError } from "./errors.js";
import type { Snapshot } from "./snapshot.js";

export const BREAKPOINT = "--> statement-breakpoint";
const ORIGIN_ID = "00000000-0000-0000-0000-000000000000";
export const EXTRAS_SNAPSHOT = "_pg-extras.json";

export type MigrationPrefix = "index" | "timestamp" | "supabase" | "unix" | "none";

export type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

export type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

export type WriteMigrationInput = {
  out: string;
  name: string;
  up: string;
  down: string;
  snapshot: Snapshot;
  prefix?: MigrationPrefix;
  breakpoints?: boolean;
};

export type WrittenMigration = {
  tag: string;
  sqlPath: string;
  downPath: string;
  layout: "journal" | "v1";
};

export function joinStatements(statements: readonly string[], breakpoints: boolean, header: string): string {
  const body = statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
  if (body.length === 0) return "";
  const separator = breakpoints ? `\n${BREAKPOINT}\n` : "\n";
  return `${header}\n${body.join(separator)}\n`;
}

export function splitMigrationSql(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function extrasSnapshotPath(out: string): string {
  return path.join(out, EXTRAS_SNAPSHOT);
}

export function readExtrasSnapshotFile(out: string): unknown | null {
  const file = extrasSnapshotPath(out);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

export function sanitizeMigrationName(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
    .replace(/_+$/g, "");
  if (!clean) throw new PgExtrasError(`migration name "${name}" is empty after sanitizing`);
  return clean;
}

export function writeMigration(input: WriteMigrationInput): WrittenMigration {
  const out = path.resolve(input.out);
  mkdirSync(out, { recursive: true });
  const layout = detectLayout(out);
  const written = layout === "v1" ? writeV1(out, input) : writeJournal(out, input);
  writeFileSync(extrasSnapshotPath(out), `${JSON.stringify(input.snapshot, null, 2)}\n`);
  return written;
}

function detectLayout(out: string): "journal" | "v1" {
  if (!existsSync(out)) return "journal";
  const entries = readdirSync(out, { withFileTypes: true });
  const v1 = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      /^\d{14}_/.test(entry.name) &&
      existsSync(path.join(out, entry.name, "migration.sql")),
  );
  const journal = existsSync(path.join(out, "meta", "_journal.json"));
  if (v1.length > 0 && journal) {
    throw new PgExtrasError(
      `migrations folder ${out} has both meta/_journal.json and v1 migration folders. Keep one layout.`,
    );
  }
  return v1.length > 0 ? "v1" : "journal";
}

function writeJournal(out: string, input: WriteMigrationInput): WrittenMigration {
  const prefixMode = input.prefix ?? "index";
  if (prefixMode === "none") {
    throw new PgExtrasError('migrations.prefix "none" is not supported. Use "index", "timestamp", "supabase", or "unix".');
  }
  const meta = path.join(out, "meta");
  mkdirSync(meta, { recursive: true });
  const journalPath = path.join(meta, "_journal.json");
  const journal = existsSync(journalPath) ? readJournal(journalPath) : emptyJournal();
  if (journal.dialect !== "postgresql") {
    throw new PgExtrasError(`drizzle-pg-extras only writes postgresql migrations. This journal is ${journal.dialect}.`);
  }
  const last = journal.entries[journal.entries.length - 1];
  const idx = last ? last.idx + 1 : 0;
  const when = Math.max(Date.now(), last ? last.when + 1 : 0);
  const prefix = migrationPrefix(idx, prefixMode);
  const suffix = sanitizeMigrationName(input.name);
  const tag = `${prefix}_${suffix}`;
  if (journal.entries.some((entry) => entry.tag === tag) || existsSync(path.join(out, `${tag}.sql`))) {
    throw new PgExtrasError(`migration ${tag} already exists in ${out}`);
  }
  const breakpoints = input.breakpoints ?? true;
  const kitSnapshot = nextKitSnapshot(readLatestKitSnapshot(meta));
  writeFileSync(path.join(meta, `${prefix}_snapshot.json`), `${JSON.stringify(kitSnapshot, null, 2)}\n`);
  journal.entries.push({ idx, version: "7", when, tag, breakpoints });
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const sqlPath = path.join(out, `${tag}.sql`);
  const downPath = path.join(out, `${tag}.down.sql`);
  writeFileSync(sqlPath, input.up);
  writeFileSync(downPath, input.down);
  return { tag, sqlPath, downPath, layout: "journal" };
}

function writeV1(out: string, input: WriteMigrationInput): WrittenMigration {
  const folders = readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const suffix = sanitizeMigrationName(input.name);
  let stamp = utcStamp(new Date());
  let folder = `${stamp}_${suffix}`;
  while (existsSync(path.join(out, folder))) {
    stamp = String(Number(stamp) + 1);
    folder = `${stamp}_${suffix}`;
  }
  const dir = path.join(out, folder);
  mkdirSync(dir, { recursive: true });
  const sqlPath = path.join(dir, "migration.sql");
  const downPath = path.join(dir, "down.sql");
  writeFileSync(sqlPath, input.up);
  writeFileSync(downPath, input.down);
  const previous = folders.length > 0 ? path.join(out, folders[folders.length - 1]!, "snapshot.json") : null;
  if (previous && existsSync(previous)) {
    const parsed = JSON.parse(readFileSync(previous, "utf8")) as Record<string, unknown>;
    let next: Record<string, unknown> = parsed;
    if (typeof parsed.id === "string") {
      const { id, prevId: _previous, ...rest } = parsed;
      next = { id: randomUUID(), prevId: id, ...rest };
    }
    writeFileSync(path.join(dir, "snapshot.json"), `${JSON.stringify(next, null, 2)}\n`);
  }
  return { tag: folder, sqlPath, downPath, layout: "v1" };
}

function emptyJournal(): Journal {
  return { version: "7", dialect: "postgresql", entries: [] };
}

function readJournal(file: string): Journal {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Journal>;
  if (!parsed || !Array.isArray(parsed.entries) || typeof parsed.dialect !== "string") {
    throw new PgExtrasError(`${file} is not a drizzle-kit journal`);
  }
  return {
    version: typeof parsed.version === "string" ? parsed.version : "7",
    dialect: parsed.dialect,
    entries: parsed.entries,
  };
}

function readLatestKitSnapshot(meta: string): Record<string, unknown> | null {
  if (!existsSync(meta)) return null;
  const files = readdirSync(meta)
    .filter((file) => !file.startsWith("_") && file.endsWith(".json"))
    .sort();
  const latest = files[files.length - 1];
  if (!latest) return null;
  return JSON.parse(readFileSync(path.join(meta, latest), "utf8")) as Record<string, unknown>;
}

function nextKitSnapshot(prev: Record<string, unknown> | null): Record<string, unknown> {
  if (!prev || typeof prev.id !== "string") {
    return {
      id: randomUUID(),
      prevId: ORIGIN_ID,
      version: "7",
      dialect: "postgresql",
      tables: {},
      enums: {},
      schemas: {},
      sequences: {},
      roles: {},
      policies: {},
      views: {},
      _meta: { columns: {}, schemas: {}, tables: {} },
    };
  }
  const { id, prevId: _previous, ...rest } = prev;
  return { id: randomUUID(), prevId: id, ...rest };
}

function migrationPrefix(idx: number, mode: MigrationPrefix): string {
  if (mode === "index") return String(idx).padStart(4, "0");
  if (mode === "unix") return String(Math.floor(Date.now() / 1000));
  if (mode === "timestamp" || mode === "supabase") return utcStamp(new Date());
  return "";
}

function utcStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

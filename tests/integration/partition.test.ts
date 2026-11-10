import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { convertPartitionedTableSql, splitMigrationSql } from "../../src/index.js";
import { run } from "../../src/cli.js";

const url = process.env.POSTGRES_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.tmp");
const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/drizzle-kit/bin.cjs");
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");

describe.skipIf(!url)("postgres partitions", () => {
  it("preserves constraints, triggers, policies, and the serial while converting an empty table", async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await resetPublic(client);
      await client.query("DROP ROLE IF EXISTS part_reader");
      await client.query("CREATE ROLE part_reader NOLOGIN");
      await client.query(`
        CREATE TABLE regions (code text PRIMARY KEY);
        CREATE TABLE events (
          id serial NOT NULL,
          created_at timestamptz NOT NULL,
          region text NOT NULL,
          note text,
          CONSTRAINT events_pk PRIMARY KEY (id, created_at),
          CONSTRAINT events_note_len CHECK (length(note) < 100)
        );
        CREATE UNIQUE INDEX events_note_uidx ON events (note, created_at);
        ALTER TABLE events ADD CONSTRAINT events_region_fk FOREIGN KEY (region) REFERENCES regions(code);
        CREATE TABLE event_refs (
          id serial PRIMARY KEY,
          event_id integer NOT NULL,
          created_at timestamptz NOT NULL,
          CONSTRAINT event_refs_event_fk FOREIGN KEY (event_id, created_at) REFERENCES events(id, created_at)
        );
        COMMENT ON TABLE events IS 'event log';
        COMMENT ON COLUMN events.region IS 'region code';
        GRANT SELECT ON events TO part_reader;
        ALTER TABLE events ENABLE ROW LEVEL SECURITY;
        CREATE POLICY events_read ON events FOR SELECT TO part_reader USING (true);
        CREATE FUNCTION events_touch() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          NEW.note = coalesce(NEW.note, 'touched');
          RETURN NEW;
        END $$;
        CREATE TRIGGER events_touch BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION events_touch();
      `);

      const convert = convertPartitionedTableSql(
        { id: "events", schema: "public", name: "events", method: "range", columns: ["created_at"] },
        "partition",
      );
      await client.query(convert);
      await client.query(convert);

      const parent = await client.query<{ relkind: string; key: string; rls: boolean }>(
        `SELECT c.relkind, pg_get_partkeydef(c.oid) AS key, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'events'`,
      );
      expect(parent.rows[0]).toEqual({ relkind: "p", key: "RANGE (created_at)", rls: true });

      const indexes = await client.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'events' ORDER BY 1",
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(["events_note_uidx", "events_pk"]);

      const constraints = await client.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'public.events'::regclass OR confrelid = 'public.events'::regclass
         ORDER BY 1`,
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        "event_refs_event_fk",
        "events_note_len",
        "events_pk",
        "events_region_fk",
      ]);

      const comment = await client.query<{ table_comment: string; column_comment: string }>(
        `SELECT obj_description('public.events'::regclass) AS table_comment,
                col_description('public.events'::regclass, 3) AS column_comment`,
      );
      expect(comment.rows[0]).toEqual({ table_comment: "event log", column_comment: "region code" });

      const policy = await client.query("SELECT polname FROM pg_policy WHERE polrelid = 'public.events'::regclass");
      expect(policy.rows[0]?.polname).toBe("events_read");
      const trigger = await client.query(
        "SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.events'::regclass AND NOT tgisinternal",
      );
      expect(trigger.rows.map((row) => row.tgname)).toEqual(["events_touch"]);
      const grant = await client.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'events' AND grantee = 'part_reader'`,
      );
      expect(grant.rows.map((row) => row.privilege_type)).toEqual(["SELECT"]);

      await client.query(`CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`);
      await client.query("INSERT INTO regions (code) VALUES ('eu')");
      const inserted = await client.query<{ tableoid: string; id: number; note: string }>(
        "INSERT INTO events (created_at, region) VALUES ('2024-06-01', 'eu') RETURNING tableoid::regclass::text AS tableoid, id, note",
      );
      expect(inserted.rows[0]).toMatchObject({ tableoid: "events_2024", note: "touched" });
      expect(inserted.rows[0]!.id).toBeGreaterThan(0);
      await expect(client.query("INSERT INTO events (created_at, region) VALUES ('2024-07-01', 'missing')")).rejects.toThrow(/events_region_fk|foreign key/i);

      const blocked = convertPartitionedTableSql(
        { id: "regions", schema: "public", name: "regions", method: "list", columns: ["code"] },
        "partition",
      );
      await expect(client.query(blocked)).rejects.toThrow(/has rows/);

      const revert = convertPartitionedTableSql(
        { id: "events", schema: "public", name: "events", method: "range", columns: ["created_at"] },
        "unpartition",
      );
      await expect(client.query(revert)).rejects.toThrow(/still has child partitions/);
      await client.query("DELETE FROM events");
      await client.query("ALTER TABLE events DETACH PARTITION events_2024");
      await client.query("DROP TABLE events_2024");
      await client.query(revert);

      const restored = await client.query<{ relkind: string }>(
        "SELECT relkind FROM pg_class WHERE oid = 'public.events'::regclass",
      );
      expect(restored.rows[0]!.relkind).toBe("r");
      const again = await client.query<{ note: string }>(
        "INSERT INTO events (created_at, region) VALUES ('2024-08-01', 'eu') RETURNING note",
      );
      expect(again.rows[0]!.note).toBe("touched");
      const stillNamed = await client.query(
        "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'events' AND indexname = 'events_pk'",
      );
      expect(stillNamed.rowCount).toBe(1);
    } finally {
      await client.query("DROP SCHEMA IF EXISTS public CASCADE").catch(() => undefined);
      await client.query("CREATE SCHEMA public").catch(() => undefined);
      await client.query("DROP ROLE IF EXISTS part_reader").catch(() => undefined);
      await client.end();
    }
  });

  it("migrates range, list, and hash partitions through drizzle-kit and rolls them back", async () => {
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "part-"));
    writeFileSync(path.join(dir, "schema.ts"), schemaSource(source));
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
      await resetPublic(client);
      const table = kitExec(dir, ["generate", "--name", "events", "--config", "drizzle.config.ts"]);
      expect(table.status, table.stderr + table.stdout).toBe(0);

      process.chdir(dir);
      expect(await run(["generate", "--name", "partitions"])).toBe(0);
      process.chdir(cwd);

      const migrate = kitExec(dir, ["migrate", "--config", "drizzle.config.ts"]);
      expect(migrate.status, migrate.stderr + migrate.stdout).toBe(0);

      const upPath = path.join(dir, "drizzle", "0001_partitions.sql");
      const upSql = readFileSync(upPath, "utf8");
      expect(upSql).toContain('RANGE ("created_at")');
      expect(upSql).toContain('LIST ("locale")');
      expect(upSql).toContain('HASH ("bucket")');
      expect(upSql).toContain("FOR VALUES FROM");
      expect(upSql).toContain("FOR VALUES IN");
      expect(upSql).toContain("MODULUS 2");
      expect(upSql).toContain("DEFAULT");
      expect(upSql).toContain("ATTACH PARTITION");
      await runStatements(client, upSql);

      await client.query("INSERT INTO regions (code) VALUES ('eu')");
      const year = await client.query<{ tableoid: string }>(
        "INSERT INTO events (created_at, region, payload) VALUES ('2024-06-01', 'eu', 'a') RETURNING tableoid::regclass::text AS tableoid",
      );
      const archived = await client.query<{ tableoid: string }>(
        "INSERT INTO events (created_at, region, payload) VALUES ('2023-06-01', 'eu', 'b') RETURNING tableoid::regclass::text AS tableoid",
      );
      const fallback = await client.query<{ tableoid: string }>(
        "INSERT INTO events (created_at, region, payload) VALUES ('2026-06-01', 'eu', 'c') RETURNING tableoid::regclass::text AS tableoid",
      );
      expect(year.rows[0]!.tableoid).toBe("events_2024");
      expect(archived.rows[0]!.tableoid).toBe("events_archive");
      expect(fallback.rows[0]!.tableoid).toBe("events_default");
      await expect(
        client.query("INSERT INTO events (created_at, region, payload) VALUES ('2024-01-02', 'nope', 'z')"),
      ).rejects.toThrow(/foreign key/i);

      const english = await client.query<{ tableoid: string }>(
        "INSERT INTO labels (id, locale) VALUES (1, 'en-US') RETURNING tableoid::regclass::text AS tableoid",
      );
      const other = await client.query<{ tableoid: string }>(
        "INSERT INTO labels (id, locale) VALUES (2, 'fr') RETURNING tableoid::regclass::text AS tableoid",
      );
      expect(english.rows[0]!.tableoid).toBe("labels_en");
      expect(other.rows[0]!.tableoid).toBe("labels_other");

      await client.query("INSERT INTO tickets (id, bucket) SELECT g, g FROM generate_series(1, 16) AS g");
      const buckets = await client.query<{ tableoid: string }>(
        "SELECT DISTINCT tableoid::regclass::text AS tableoid FROM tickets ORDER BY 1",
      );
      expect(buckets.rows.map((row) => row.tableoid)).toEqual(["tickets_0", "tickets_1"]);

      const comment = await client.query<{ table_comment: string }>(
        "SELECT obj_description('public.events'::regclass) AS table_comment",
      );
      expect(comment.rows[0]!.table_comment).toBe("Events");

      const before = sqlFiles(path.join(dir, "drizzle"));
      const again = kitExec(dir, ["generate", "--name", "noop", "--config", "drizzle.config.ts"]);
      expect(again.status, again.stderr + again.stdout).toBe(0);
      expect(again.stdout).toContain("No schema changes");
      expect(sqlFiles(path.join(dir, "drizzle"))).toEqual(before);

      await client.query("DELETE FROM events");
      await client.query("DELETE FROM labels");
      await client.query("DELETE FROM tickets");
      await runStatements(client, readFileSync(path.join(dir, "drizzle", "0001_partitions.down.sql"), "utf8"));

      const kinds = await client.query<{ relname: string; relkind: string }>(
        `SELECT c.relname, c.relkind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname IN ('events', 'events_archive', 'events_2024', 'labels', 'tickets')
         ORDER BY 1`,
      );
      expect(kinds.rows).toEqual([
        { relname: "events", relkind: "r" },
        { relname: "events_archive", relkind: "r" },
        { relname: "labels", relkind: "r" },
        { relname: "tickets", relkind: "r" },
      ]);
      const restored = await client.query<{ id: number }>(
        "INSERT INTO events (created_at, region, payload) VALUES ('2024-06-01', 'eu', 'after') RETURNING id",
      );
      expect(restored.rows[0]!.id).toBeGreaterThan(0);
    } finally {
      process.chdir(cwd);
      await client.end();
    }
  });
});

function schemaSource(sourcePath: string): string {
  return `import { integer, pgTable, serial, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { partitionedTable, pgAttachPartition, pgPartition, withComment } from ${JSON.stringify(sourcePath)};

export const regions = pgTable("regions", {
  code: text("code").primaryKey(),
});

export const events = withComment(pgTable("events", {
  id: serial("id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  region: text("region").notNull().references(() => regions.code),
  payload: text("payload").notNull(),
}, (t) => [
  primaryKey({ columns: [t.id, t.createdAt] }),
]), "Events");

export const eventsPartition = partitionedTable(events, {
  method: "range",
  columns: [events.createdAt],
});

export const events2024 = pgPartition("events_2024", {
  parent: events,
  from: ["2024-01-01"],
  to: ["2025-01-01"],
});

export const eventsDefault = pgPartition("events_default", {
  parent: events,
  default: true,
});

export const eventsArchive = pgTable("events_archive", {
  id: integer("id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  region: text("region").notNull().references(() => regions.code),
  payload: text("payload").notNull(),
}, (t) => [
  primaryKey({ columns: [t.id, t.createdAt] }),
]);

export const attachArchive = pgAttachPartition(eventsArchive, {
  parent: events,
  from: ["2020-01-01"],
  to: ["2024-01-01"],
});

export const labels = pgTable("labels", {
  id: integer("id").notNull(),
  locale: text("locale").notNull(),
}, (t) => [
  primaryKey({ columns: [t.id, t.locale] }),
]);

export const labelsPartition = partitionedTable(labels, {
  method: "list",
  columns: [labels.locale],
});

export const labelsEn = pgPartition("labels_en", {
  parent: labels,
  in: ["en", "en-US"],
});

export const labelsOther = pgPartition("labels_other", {
  parent: labels,
  default: true,
});

export const tickets = pgTable("tickets", {
  id: integer("id").notNull(),
  bucket: integer("bucket").notNull(),
}, (t) => [
  primaryKey({ columns: [t.bucket, t.id] }),
]);

export const ticketsPartition = partitionedTable(tickets, {
  method: "hash",
  columns: [tickets.bucket],
});

export const tickets0 = pgPartition("tickets_0", {
  parent: tickets,
  modulus: 2,
  remainder: 0,
});

export const tickets1 = pgPartition("tickets_1", {
  parent: tickets,
  modulus: 2,
  remainder: 1,
});
`;
}

async function resetPublic(client: pg.Client): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await client.query("GRANT ALL ON SCHEMA public TO public");
}

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

function sqlFiles(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql")).sort();
}

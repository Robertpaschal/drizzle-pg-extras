import { integer, pgSchema, pgTable, serial, text, timestamp, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  collectExtras,
  defineExtras,
  diffSnapshots,
  emptySnapshot,
  parseSnapshot,
  pgAttachPartition,
  pgDetachPartition,
  pgPartition,
  partitionedTable,
  renderIdempotent,
  snapshotExtras,
} from "../../src/index.js";

function eventsTable() {
  return pgTable("events", {
    id: serial("id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    region: text("region").notNull(),
    payload: text("payload").notNull(),
  }, (t) => [primaryKey({ columns: [t.id, t.createdAt] })]);
}

function eventsExtras() {
  const events = eventsTable();
  const archive = pgTable("events_archive", {
    id: integer("id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    region: text("region").notNull(),
    payload: text("payload").notNull(),
  }, (t) => [primaryKey({ columns: [t.id, t.createdAt] })]);
  const parent = partitionedTable(events, { method: "range", columns: [events.createdAt] });
  return {
    events,
    archive,
    extras: defineExtras({
      tables: [events, archive],
      partitionedTables: [parent],
      partitions: [
        pgPartition("events_2024", { parent: events, from: ["2024-01-01"], to: ["2025-01-01"] }),
        pgPartition("events_open", { parent: events, from: ["MINVALUE"], to: ["2024-01-01"] }),
        pgPartition("events_default", { parent: events, default: true }),
        pgAttachPartition(archive, { parent: events, from: ["2020-01-01"], to: ["2024-01-01"] }),
      ],
    }),
  };
}

describe("partition sql", () => {
  it("converts an empty parent and declares range, default, and attach partitions", () => {
    const { extras } = eventsExtras();
    const diff = diffSnapshots(emptySnapshot(), snapshotExtras(extras));
    const up = diff.up.join("\n\n");
    expect(up).toContain('Convert empty "public"."events" into a RANGE ("created_at") partitioned table');
    expect(up).toContain(`partition_by text := 'RANGE ("created_at")'`);
    expect(up).toContain("INCLUDING ALL) PARTITION BY %s");
    expect(up).toContain("ALTER SEQUENCE %I.%I OWNED BY %I.%I.%I");
    expect(up).toContain("has rows, so it cannot be converted");
    expect(up.indexOf('into a RANGE ("created_at")')).toBeLessThan(up.indexOf("events_2024"));
    expect(up).toContain(`bound_sql text := 'FOR VALUES FROM (''2024-01-01'') TO (''2025-01-01'')'`);
    expect(up).toContain(`bound_sql text := 'FOR VALUES FROM (MINVALUE) TO (''2024-01-01'')'`);
    expect(up).toContain(`bound_sql text := 'DEFAULT'`);
    expect(up).toContain("CREATE TABLE %I.%I PARTITION OF %I.%I %s");
    expect(up).toContain("ALTER TABLE %I.%I ATTACH PARTITION %I.%I %s");
    expect(up).not.toContain("DETACH PARTITION");
    const down = diff.down.join("\n\n");
    expect(down.indexOf("Drop empty partition")).toBeLessThan(down.indexOf("back into a regular table"));
    expect(down).toContain('Detach "public"."events_archive"');
    expect(down).not.toContain('Drop empty partition "public"."events_archive"');
    expect(diffSnapshots(snapshotExtras(extras), snapshotExtras(eventsExtras().extras)).up).toEqual([]);
  });

  it("renders list, hash, and escaped values, and keeps renderIdempotent idempotent", () => {
    const labels = pgTable("labels", {
      id: integer("id").notNull(),
      locale: text("locale").notNull(),
    }, (t) => [primaryKey({ columns: [t.id, t.locale] })]);
    const tickets = pgTable("tickets", {
      id: integer("id").notNull(),
      bucket: integer("bucket").notNull(),
    }, (t) => [primaryKey({ columns: [t.bucket, t.id] })]);
    const extras = defineExtras({
      partitionedTables: [
        partitionedTable(labels, { method: "list", columns: [labels.locale] }),
        partitionedTable(tickets, { method: "hash", columns: [tickets.bucket] }),
      ],
      partitions: [
        pgPartition("labels_en", { parent: labels, in: ["en", "o'reilly"] }),
        pgPartition("labels_rest", { parent: labels, default: true, onRemove: "detach" }),
        pgPartition("tickets_0", { parent: tickets, modulus: 4, remainder: 0 }),
        pgPartition("tickets_1", { parent: tickets, modulus: 4, remainder: 1 }),
      ],
    });
    const up = diffSnapshots(emptySnapshot(), snapshotExtras(extras)).up.join("\n");
    expect(up).toContain(`bound_sql text := 'FOR VALUES IN (''en'', ''o''''reilly'')'`);
    expect(up).toContain(`bound_sql text := 'FOR VALUES WITH (MODULUS 4, REMAINDER 0)'`);
    expect(up).toContain(`bound_sql text := 'FOR VALUES WITH (MODULUS 4, REMAINDER 1)'`);
    const script = renderIdempotent(extras);
    expect(script).toContain('LIST ("locale")');
    expect(script).toContain('HASH ("bucket")');
    expect(script).toContain("CREATE TABLE %I.%I PARTITION OF");
    expect(script).not.toContain("Drop empty partition");
  });

  it("drops a created partition and detaches when asked, and detaches an explicit declaration", () => {
    const events = eventsTable();
    const parent = partitionedTable(events, { method: "range", columns: [events.createdAt] });
    const kept = defineExtras({
      partitionedTables: [parent],
      partitions: [
        pgPartition("events_2024", { parent: events, from: ["2024-01-01"], to: ["2025-01-01"], onRemove: "detach" }),
        pgPartition("events_2025", { parent: events, from: ["2025-01-01"], to: ["2026-01-01"] }),
      ],
    });
    const removed = defineExtras({
      partitionedTables: [parent],
      partitions: [pgPartition("events_2025", { parent: events, from: ["2025-01-01"], to: ["2026-01-01"] })],
      detaches: [pgDetachPartition(pgTable("events_2024", { id: integer("id") }), { parent: events })],
    });
    const up = diffSnapshots(snapshotExtras(kept), snapshotExtras(removed)).up.join("\n");
    expect(up).toContain('Detach "public"."events_2024"');
    expect(up).not.toContain("Drop empty partition");
    expect(up).not.toContain("events_2025");
  });

  it("applies snake_case to key columns and qualifies a non-public schema", () => {
    const auth = pgSchema("auth");
    const events = auth.table("events", {
      id: integer("id").notNull(),
      createdAt: timestamp().notNull(),
    }, (t) => [primaryKey({ columns: [t.id, t.createdAt] })]);
    const extras = defineExtras({
      partitionedTables: [partitionedTable(events, { method: "range", columns: [events.createdAt] })],
      partitions: [pgPartition("events_2024", { parent: events, schema: "archive", from: ["2024-01-01"], to: ["2025-01-01"] })],
    });
    const snap = snapshotExtras(extras, { casing: "snake_case" });
    expect(snap.partitionedTables[0]).toMatchObject({ schema: "auth", name: "events", columns: ["created_at"] });
    expect(snap.partitions[0]).toMatchObject({ schema: "archive", parentSchema: "auth" });
    const up = diffSnapshots(emptySnapshot(), snap).up.join("\n");
    expect(up).toContain(`'RANGE ("created_at")'`);
    expect(up).toContain(`parent_schema text := 'auth'`);
    expect(up).toContain(`child_schema text := 'archive'`);
  });

  it("reads a v0.1 snapshot that has no partition keys", () => {
    const parsed = parseSnapshot({
      version: 1,
      functions: [],
      triggers: [],
      extensions: [],
      comments: [],
      inventory: { scanned: true, tables: [] },
    });
    expect(parsed.partitionedTables).toEqual([]);
    expect(parsed.hypertables).toEqual([]);
    expect(diffSnapshots(parsed, parsed).up).toEqual([]);
  });

  it("collects partitioned tables exported beside the Drizzle table", () => {
    const events = eventsTable();
    const parent = partitionedTable(events, { method: "range", columns: [events.createdAt] });
    const child = pgPartition("events_2024", { parent: parent, from: ["2024-01-01"], to: ["2025-01-01"] });
    const extras = collectExtras({ events, parent, child });
    expect(extras.tables).toContain(events);
    expect(snapshotExtras(extras).partitions).toHaveLength(1);
  });
});

describe("partition definition checks", () => {
  const events = eventsTable();

  it("rejects a primary key that does not include the partition key", () => {
    const users = pgTable("users", {
      id: serial("id").primaryKey(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    });
    expect(() => partitionedTable(users, { method: "range", columns: [users.createdAt] })).toThrow(/partition key/);
    expect(() =>
      partitionedTable(events, { method: "range", columns: [events.createdAt, events.createdAt] }),
    ).toThrow(/duplicate/);
  });

  it("rejects a unique index that omits the partition key", () => {
    const logged = pgTable("logged", {
      id: integer("id").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      email: text("email").notNull(),
    }, (t) => [
      primaryKey({ columns: [t.id, t.createdAt] }),
      uniqueIndex("logged_email_uidx").on(t.email),
    ]);
    expect(() => partitionedTable(logged, { method: "range", columns: [logged.createdAt] })).toThrow(/logged_email_uidx/);
  });

  it("rejects bounds that do not match the parent strategy", () => {
    const parent = partitionedTable(events, { method: "range", columns: [events.createdAt] });
    const hashed = pgTable("tickets", {
      id: integer("id").notNull(),
      bucket: integer("bucket").notNull(),
    }, (t) => [primaryKey({ columns: [t.bucket, t.id] })]);
    const hashParent = partitionedTable(hashed, { method: "hash", columns: [hashed.bucket] });
    expect(() =>
      snapshotExtras(defineExtras({
        partitionedTables: [parent],
        partitions: [pgPartition("events_eu", { parent: events, in: ["eu"] })],
      })),
    ).toThrow(/range/);
    expect(() =>
      snapshotExtras(defineExtras({
        partitionedTables: [hashParent],
        partitions: [pgPartition("tickets_default", { parent: hashed, default: true })],
      })),
    ).toThrow(/DEFAULT/);
    expect(() => pgPartition("events_bad", { parent: events, modulus: 4, remainder: 4 })).toThrow(/remainder/);
    expect(() => pgPartition("events_orphan", { parent: events, from: ["2024-01-01"], to: ["2025-01-01", "extra"] })).toThrow(/one bound per partition column/);
    expect(() =>
      snapshotExtras(defineExtras({
        partitions: [pgPartition("events_2024", { parent: events, from: ["2024-01-01"], to: ["2025-01-01"] })],
      })),
    ).toThrow(/no partitionedTable/);
  });

  it("refuses to change a partition key or bounds in a generated migration", () => {
    const events = eventsTable();
    const before = snapshotExtras(defineExtras({
      partitionedTables: [partitionedTable(events, { method: "range", columns: [events.createdAt] })],
      partitions: [pgPartition("events_2024", { parent: events, from: ["2024-01-01"], to: ["2025-01-01"] })],
    }));
    const keyChange = snapshotExtras(defineExtras({
      partitionedTables: [partitionedTable(events, { method: "range", columns: [events.id] })],
      partitions: [pgPartition("events_2024", { parent: events, from: [0], to: [100] })],
    }));
    expect(() => diffSnapshots(before, keyChange)).toThrow(/cannot change a partition key/);
    const boundChange = snapshotExtras(defineExtras({
      partitionedTables: [partitionedTable(events, { method: "range", columns: [events.createdAt] })],
      partitions: [pgPartition("events_2024", { parent: events, from: ["2023-01-01"], to: ["2024-01-01"] })],
    }));
    expect(() => diffSnapshots(before, boundChange)).toThrow(/cannot alter partition bounds/);
  });
});

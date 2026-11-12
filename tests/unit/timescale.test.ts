import { integer, pgSchema, pgTable, text, timestamp, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  collectExtras,
  defineExtras,
  diffSnapshots,
  emptySnapshot,
  hypertable,
  parseSnapshot,
  partitionedTable,
  pgExtension,
  renderIdempotent,
  snapshotExtras,
} from "../../src/index.js";

function metricsTable() {
  return pgTable("metrics", {
    time: timestamp("time", { withTimezone: true }).notNull(),
    deviceId: text("device_id").notNull(),
    value: integer("value").notNull(),
  }, (t) => [primaryKey({ columns: [t.time, t.deviceId] })]);
}

function metricsHypertable(table = metricsTable(), migrateData = false) {
  return hypertable(table, {
    timeColumn: table.time,
    chunkTimeInterval: "1 day",
    partitioningColumn: table.deviceId,
    numberPartitions: 4,
    migrateData,
    compression: {
      segmentBy: [table.deviceId],
      orderBy: [{ column: table.time, direction: "desc", nulls: "last" }],
    },
    retention: { dropAfter: "6 months", scheduleInterval: "1 day" },
    compressionPolicy: { compressAfter: "7 days" },
  });
}

function fullExtras(table = metricsTable(), migrateData = false) {
  return defineExtras({
    extensions: [pgExtension("timescaledb")],
    tables: [table],
    hypertables: [metricsHypertable(table, migrateData)],
  });
}

describe("hypertable sql", () => {
  it("emits create_hypertable, compression, and policies after the extension", () => {
    const diff = diffSnapshots(emptySnapshot(), snapshotExtras(fullExtras()));
    const up = diff.up.join("\n");
    expect(up.indexOf('CREATE EXTENSION IF NOT EXISTS "timescaledb"')).toBeLessThan(up.indexOf("create_hypertable"));
    expect(up).toContain(
      `SELECT create_hypertable('"public"."metrics"'::regclass, 'time'::name, partitioning_column => 'device_id'::name, number_partitions => 4, chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);`,
    );
    expect(up).toContain(`timescaledb.compress_segmentby = '"device_id"'`);
    expect(up).toContain(`timescaledb.compress_orderby = '"time" DESC NULLS LAST'`);
    expect(up).toContain(
      `SELECT add_compression_policy('"public"."metrics"'::regclass, compress_after => INTERVAL '7 days', if_not_exists => TRUE);`,
    );
    expect(up).toContain(
      `SELECT add_retention_policy('"public"."metrics"'::regclass, drop_after => INTERVAL '6 months', schedule_interval => INTERVAL '1 day', if_not_exists => TRUE);`,
    );
    expect(up.indexOf("timescaledb.compress")).toBeLessThan(up.indexOf("add_compression_policy"));
    const down = diff.down.join("\n");
    expect(down.indexOf("remove_compression_policy")).toBeLessThan(down.indexOf("timescaledb.compress = false"));
    expect(down).toContain("remove_retention_policy");
    expect(down).toContain("stays a hypertable");
    expect(down).not.toContain("DROP EXTENSION");
    expect(down).not.toContain("create_hypertable");
    expect(diffSnapshots(snapshotExtras(fullExtras()), snapshotExtras(fullExtras())).up).toEqual([]);
  });

  it("keeps renderIdempotent to creates and ignores a migrateData-only edit", () => {
    const script = renderIdempotent(fullExtras());
    expect(script).toContain("if_not_exists => TRUE");
    expect(script).not.toContain("migrate_data");
    expect(script).not.toContain("remove_retention_policy");
    const withMigrate = snapshotExtras(fullExtras(metricsTable(), true));
    expect(withMigrate.hypertables[0]?.migrateData).toBe(true);
    expect(diffSnapshots(snapshotExtras(fullExtras()), withMigrate).up).toEqual([]);
    expect(renderIdempotent(fullExtras(metricsTable(), true))).toContain("migrate_data => TRUE");
  });

  it("normalizes intervals and updates chunk time, space, compression, and policies in place", () => {
    const metrics = metricsTable();
    const before = snapshotExtras(defineExtras({
      extensions: [pgExtension("TimescaleDB")],
      hypertables: [hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: "  1   Day " })],
    }));
    expect(before.hypertables[0]?.chunkTimeInterval).toBe("1 day");
    expect(before.extensions[0]?.name).toBe("timescaledb");

    const interval = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: "2 days" })],
    }));
    const intervalSql = diffSnapshots(before, interval).up.join("\n");
    expect(intervalSql).toContain(`SELECT set_chunk_time_interval('"public"."metrics"'::regclass, INTERVAL '2 days');`);
    expect(intervalSql).not.toContain("create_hypertable");

    const spaced = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [hypertable(metrics, {
        timeColumn: metrics.time,
        chunkTimeInterval: "1 day",
        partitioningColumn: metrics.deviceId,
        numberPartitions: 4,
      })],
    }));
    const spaceSql = diffSnapshots(before, spaced).up.join("\n");
    expect(spaceSql).toContain(`SELECT add_dimension('"public"."metrics"'::regclass, 'device_id'::name, number_partitions => 4, if_not_exists => TRUE);`);
    expect(spaceSql).not.toContain("create_hypertable");

    const compressed = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [hypertable(metrics, {
        timeColumn: metrics.time,
        chunkTimeInterval: "1 day",
        compression: { segmentBy: [metrics.deviceId] },
        retention: { dropAfter: "6 months" },
        compressionPolicy: { compressAfter: "7 days" },
      })],
    }));
    const cleared = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [hypertable(metrics, {
        timeColumn: metrics.time,
        chunkTimeInterval: "1 day",
        compression: {},
        retention: { dropAfter: "3 months" },
      })],
    }));
    const changed = diffSnapshots(compressed, cleared).up.join("\n");
    expect(changed.indexOf("remove_compression_policy")).toBeLessThan(changed.indexOf("timescaledb.compress_segmentby = ''"));
    expect(changed).not.toContain("add_compression_policy");
    expect(changed.indexOf("remove_retention_policy")).toBeLessThan(changed.indexOf("drop_after => INTERVAL '3 months'"));
  });

  it("applies snake_case and qualifies a non-public schema", () => {
    const market = pgSchema("market");
    const readings = market.table("readings", {
      createdAt: timestamp({ withTimezone: true }).notNull(),
      value: integer().notNull(),
    });
    const snap = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [hypertable(readings, { timeColumn: readings.createdAt, chunkTimeInterval: "1 hour" })],
    }), { casing: "snake_case" });
    expect(snap.hypertables[0]).toMatchObject({ schema: "market", name: "readings", timeColumn: "created_at" });
    expect(diffSnapshots(emptySnapshot(), snap).up.join("\n")).toContain(
      `SELECT create_hypertable('"market"."readings"'::regclass, 'created_at'::name, chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE);`,
    );
  });

  it("accepts a { name, schema } table and reads a snapshot that has no hypertable key", () => {
    const snap = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [hypertable({ name: "metrics", schema: "market" }, { timeColumn: "time", chunkTimeInterval: "1 day" })],
    }));
    expect(snap.hypertables[0]).toMatchObject({ schema: "market", name: "metrics", timeColumn: "time" });
    const parsed = parseSnapshot({ version: 1, functions: [], triggers: [], extensions: [], comments: [] });
    expect(parsed.hypertables).toEqual([]);
    expect(diffSnapshots(parsed, parsed).up).toEqual([]);
  });

  it("collects an exported hypertable and the table it wraps", () => {
    const metrics = metricsTable();
    const declared = metricsHypertable(metrics);
    const extras = collectExtras({ timescale: pgExtension("timescaledb"), metrics, declared });
    expect(extras.tables).toContain(metrics);
    expect(extras.hypertables).toHaveLength(1);
    expect(snapshotExtras(extras).hypertables[0]?.name).toBe("metrics");
  });

  it("drops the extension when the Drizzle table leaves with the hypertable", () => {
    const before = snapshotExtras(fullExtras());
    const after = snapshotExtras(defineExtras({}));
    const up = diffSnapshots(before, after).up.join("\n");
    expect(up).toContain('DROP EXTENSION IF EXISTS "timescaledb"');
    expect(up).not.toContain("create_hypertable");
    expect(up).not.toContain("remove_retention_policy");
  });
});

describe("hypertable definition checks", () => {
  const metrics = metricsTable();

  it("requires the timescaledb extension", () => {
    expect(() => snapshotExtras(defineExtras({
      hypertables: [hypertable(metrics, { timeColumn: metrics.time })],
    }))).toThrow(/pgExtension\("timescaledb"\)/);
  });

  it("rejects a time column that is nullable, the wrong type, or not on the table", () => {
    const loose = pgTable("loose", {
      time: timestamp("time", { withTimezone: true }),
      note: text("note").notNull(),
    });
    expect(() => hypertable(loose, { timeColumn: loose.time })).toThrow(/NOT NULL/);
    expect(() => hypertable(metrics, { timeColumn: metrics.value })).toThrow(/integer/);
    expect(() => hypertable(metrics, { timeColumn: loose.time as never })).toThrow(/does not belong/);
  });

  it("rejects a primary key or unique index that omits the hypertable key", () => {
    const keyed = pgTable("keyed", {
      id: integer("id").primaryKey(),
      time: timestamp("time", { withTimezone: true }).notNull(),
    });
    expect(() => hypertable(keyed, { timeColumn: keyed.time })).toThrow(/hypertable key/);
    const logged = pgTable("logged", {
      time: timestamp("time", { withTimezone: true }).notNull(),
      deviceId: text("device_id").notNull(),
      email: text("email").notNull(),
    }, (t) => [
      primaryKey({ columns: [t.time, t.deviceId] }),
      uniqueIndex("logged_email_uidx").on(t.email),
    ]);
    expect(() => hypertable(logged, {
      timeColumn: logged.time,
      partitioningColumn: logged.deviceId,
      numberPartitions: 2,
    })).toThrow(/logged_email_uidx/);
  });

  it("rejects intervals, space partitions, and policies that Timescale cannot apply", () => {
    expect(() => hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: "1 day'; drop table metrics" })).toThrow(/interval/);
    expect(() => hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: "0 days" })).toThrow(/greater than 0/);
    expect(() => hypertable(metrics, { timeColumn: metrics.time, partitioningColumn: metrics.deviceId })).toThrow(/together/);
    expect(() => hypertable(metrics, { timeColumn: metrics.time, numberPartitions: 0 })).toThrow(/together|integer/);
    expect(() => hypertable(metrics, {
      timeColumn: metrics.time,
      partitioningColumn: metrics.time,
      numberPartitions: 2,
    })).toThrow(/different column/);
    expect(() => hypertable(metrics, {
      timeColumn: metrics.time,
      compressionPolicy: { compressAfter: "7 days" },
    })).toThrow(/compressionPolicy requires compression/);
    expect(() => hypertable(metrics, {
      timeColumn: metrics.time,
      compression: { orderBy: [{ column: metrics.time, direction: "sideways" as "asc" }] },
    })).toThrow(/direction/);
  });

  it("refuses to drop a hypertable, clear its interval, or change the time or space key", () => {
    const before = snapshotExtras(fullExtras());
    const kept = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      tables: [metrics],
    }));
    expect(() => diffSnapshots(before, kept)).toThrow(/will not convert a hypertable back/);

    const cleared = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [hypertable(metrics, {
        timeColumn: metrics.time,
        partitioningColumn: metrics.deviceId,
        numberPartitions: 4,
        compression: {
          segmentBy: [metrics.deviceId],
          orderBy: [{ column: metrics.time, direction: "desc", nulls: "last" }],
        },
        retention: { dropAfter: "6 months", scheduleInterval: "1 day" },
        compressionPolicy: { compressAfter: "7 days" },
      })],
    }));
    expect(() => diffSnapshots(before, cleared)).toThrow(/clearing chunkTimeInterval/);

    const retimed = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [hypertable(metrics, {
        timeColumn: metrics.time,
        chunkTimeInterval: "1 day",
        partitioningColumn: metrics.deviceId,
        numberPartitions: 8,
      })],
    }));
    expect(() => diffSnapshots(before, retimed)).toThrow(/space partition changed/);

    const other = pgTable("metrics", {
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      deviceId: text("device_id").notNull(),
      value: integer("value").notNull(),
    }, (t) => [primaryKey({ columns: [t.createdAt, t.deviceId] })]);
    const moved = snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [hypertable(other, {
        timeColumn: other.createdAt,
        chunkTimeInterval: "1 day",
        partitioningColumn: other.deviceId,
        numberPartitions: 4,
        compression: {
          segmentBy: [other.deviceId],
          orderBy: [{ column: other.createdAt, direction: "desc", nulls: "last" }],
        },
        retention: { dropAfter: "6 months", scheduleInterval: "1 day" },
        compressionPolicy: { compressAfter: "7 days" },
      })],
    }));
    expect(() => diffSnapshots(before, moved)).toThrow(/time column changed/);
  });

  it("rejects a table that is also a native partitioned table, and a second declaration", () => {
    expect(() => snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      partitionedTables: [partitionedTable(metrics, { method: "range", columns: [metrics.time] })],
      hypertables: [hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: "1 day" })],
    }))).toThrow(/both a partitioned table and a hypertable/);
    expect(() => snapshotExtras(defineExtras({
      extensions: [pgExtension("timescaledb")],
      hypertables: [
        hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: "1 day" }),
        hypertable(metrics, { timeColumn: metrics.time, chunkTimeInterval: "2 days" }),
      ],
    }))).toThrow(/declared more than once/);
  });
});

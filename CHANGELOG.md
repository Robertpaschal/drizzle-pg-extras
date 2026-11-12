# Changelog

## 0.5.0

TimescaleDB hypertables, for [drizzle-orm#2962](https://github.com/drizzle-team/drizzle-orm/issues/2962).

- `hypertable()` appends `create_hypertable(..., if_not_exists => TRUE)` for a table drizzle-kit already created. Optional `chunkTimeInterval`, `partitioningColumn` / `numberPartitions`, and `migrateData`.
- Optional compression settings, `add_retention_policy`, and `add_compression_policy`.
- `pgExtension("timescaledb")` is required. `generate` throws if it is not in the schema.
- Continuous aggregates are not generated. This is a community package, not an official Timescale or Drizzle release.
- `_pg-extras.json` from 0.4.0 still loads. Hypertable keys are added the next time a migration is written.

## 0.4.0

The rest of `CREATE TRIGGER`, for [drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843) and the deferrable trigger case in [drizzle-orm#1429](https://github.com/drizzle-team/drizzle-orm/issues/1429).

- `constraint: true`, or `{ deferrable, initially, from }`, emits `CREATE CONSTRAINT TRIGGER`. `initially: "deferred"` requires `deferrable: true`. `from` is the referenced table. Postgres has no `OR REPLACE` for these, so a new or changed constraint trigger is `DROP TRIGGER IF EXISTS` plus create. Its comment is written again when the trigger is replaced.
- `referencing: { oldTable, newTable }` emits `REFERENCING OLD TABLE AS ... NEW TABLE AS ...` on an `AFTER` trigger, for one event, at row or statement level.
- `WHEN` and `UPDATE OF` were already emitted. They are now rejected at declaration when Postgres would reject them: `INSTEAD OF`, a statement `WHEN` that reads `OLD` or `NEW`, an `INSERT` `WHEN` that reads `OLD`, and a `DELETE` `WHEN` that reads `NEW`.
- `INSTEAD OF` accepts a `pgView()`. `BEFORE` and `AFTER` on a view must be `forEach: "statement"`. Materialized views cannot have triggers.
- `enabled: false` appends `ALTER TABLE ... DISABLE TRIGGER`. Turning it back on emits `ENABLE TRIGGER` without recreating the trigger. `CREATE OR REPLACE` enables a trigger, so a definition change that stays disabled emits `DISABLE` again.
- `_pg-extras.json` from 0.3.0 still loads. A trigger comment stored there still clears with `COMMENT ON TRIGGER ... IS NULL`.

## 0.3.0

Comments for the rest of the objects in [drizzle-orm#886](https://github.com/drizzle-team/drizzle-orm/issues/886).

- `withComment` and `commentOn` now cover enums, views, materialized views, `pgFunction` functions, triggers, and extensions.
- `withComment` on an index, unique index, `unique`, `check`, `primaryKey`, or `foreignKey` builder emits `COMMENT ON INDEX` or `COMMENT ON CONSTRAINT`. Put it inside the table extra-config callback.
- Removing a comment emits `COMMENT … IS NULL`. If the object itself was dropped, that statement is omitted.
- The statements are idempotent. A later `drizzle-kit generate` still reports no schema changes.
- `_pg-extras.json` from 0.1.0 and 0.2.0 still loads.

## 0.2.0

Declarative Postgres partitioning, for [drizzle-orm#2854](https://github.com/drizzle-team/drizzle-orm/issues/2854).

- `partitionedTable()` declares a `RANGE`, `LIST`, or `HASH` parent. The table stays in the Drizzle schema. `generate` converts the empty table drizzle-kit created and refuses to run when the table has rows.
- `pgPartition()` creates a child: `FOR VALUES FROM/TO`, `IN`, `WITH (MODULUS, REMAINDER)`, or `DEFAULT`.
- `pgAttachPartition()` and `pgDetachPartition()` attach and detach an existing table.
- Postgres 14 or newer. `generate` and `drizzle-kit migrate` only. `drizzle-kit push` is not supported.
- `_pg-extras.json` from 0.1.0 still loads. Partition keys are added the next time a migration is written.

## 0.1.0

Initial release. Functions, triggers, table and column comments, and extensions, written as drizzle-kit migrations.

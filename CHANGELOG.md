# Changelog

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

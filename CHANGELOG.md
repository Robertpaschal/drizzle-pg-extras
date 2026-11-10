# Changelog

## 0.2.0

Declarative Postgres partitioning, for [drizzle-orm#2854](https://github.com/drizzle-team/drizzle-orm/issues/2854).

- `partitionedTable()` declares a `RANGE`, `LIST`, or `HASH` parent. The table stays in the Drizzle schema. `generate` converts the empty table drizzle-kit created and refuses to run when the table has rows.
- `pgPartition()` creates a child: `FOR VALUES FROM/TO`, `IN`, `WITH (MODULUS, REMAINDER)`, or `DEFAULT`.
- `pgAttachPartition()` and `pgDetachPartition()` attach and detach an existing table.
- Postgres 14 or newer. `generate` and `drizzle-kit migrate` only. `drizzle-kit push` is not supported.
- `_pg-extras.json` from 0.1.0 still loads. Partition keys are added the next time a migration is written.

## 0.1.0

Initial release. Functions, triggers, table and column comments, and extensions, written as drizzle-kit migrations.

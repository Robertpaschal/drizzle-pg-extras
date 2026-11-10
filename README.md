# drizzle-pg-extras

Declare the Postgres objects Drizzle still can't model — functions, triggers, comments, extensions, and partitioned tables — in TypeScript next to your Drizzle tables, and turn them into ordinary SQL migration files.

`drizzle-kit migrate` applies those files. This package does not patch Drizzle. If Drizzle later generates the same objects itself, the SQL you already committed stays valid.

## Why

These are open Drizzle requests, and the v1.0.0-rc.5 notes don't add them. [PR #4844](https://github.com/drizzle-team/drizzle-orm/pull/4844) is still unmerged.

| Gap | Request |
| --- | --- |
| `CREATE FUNCTION` / `CREATE TRIGGER` | [drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843) |
| `COMMENT ON` tables, columns, enums, views, routines, indexes, constraints, extensions | [drizzle-orm#886](https://github.com/drizzle-team/drizzle-orm/issues/886) |
| `CREATE EXTENSION` | [drizzle-orm#2124](https://github.com/drizzle-team/drizzle-orm/issues/2124) |
| Partitioned tables | [drizzle-orm#2854](https://github.com/drizzle-team/drizzle-orm/issues/2854) |

Smaller packages already cover one of those pieces each: [`drizzle-triggers`](https://github.com/RagedPanda/drizzle-triggers), [`@onozaty/drizzle-db-comments-generator`](https://github.com/onozaty/drizzle-db-comments-generator), and [`drizzle-partition`](https://github.com/Rezarys/drizzle-partition). This package is the Postgres slice people keep asking to put in one schema: functions, triggers, comments, extensions, and partitions. `drizzle-partition` rewrites the `CREATE TABLE` drizzle-kit already wrote. This package leaves that file alone and appends a migration. See [Partitioning](#partitioning).

## Example

```ts
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { pgExtension, updatedAtTrigger, withComment } from "drizzle-pg-extras";

export const pgcrypto = pgExtension("pgcrypto");

export const users = withComment(pgTable("users", {
  id: serial("id").primaryKey(),
  email: withComment(text("email").notNull(), "Login email"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}), "Application users");

export const touchUsers = updatedAtTrigger(users, users.updatedAt);
```

```sh
drizzle-kit generate && drizzle-pg-extras generate && drizzle-kit migrate
```

`updatedAtTrigger` is the case from issue #843: a `BEFORE UPDATE` trigger that sets the column to `now()` for every update, including ones that never go through Drizzle. A hand-written function looks like this:

```ts
export const setUpdatedAt = pgFunction("set_updated_at", {
  returns: "trigger",
  language: "plpgsql",
  body: "BEGIN NEW.updated_at = now(); RETURN NEW; END;",
});

export const touchUsers = pgTrigger("users_set_updated_at", {
  table: users,
  timing: "before",
  events: ["update"],
  columns: [users.email], // UPDATE OF, and the column must belong to `users`
  when: ({ OLD, NEW }) => sql`${OLD.email} IS DISTINCT FROM ${NEW.email}`,
  function: setUpdatedAt,
});
```

The first `generate` writes a migration. The next one writes nothing until a definition changes. Only the difference is emitted, and the statements themselves are idempotent (`CREATE OR REPLACE`, `IF NOT EXISTS`, `DROP … IF EXISTS`).

## Install

```sh
npm install drizzle-pg-extras
```

Peer dependency: `drizzle-orm` `>=0.36.4`. `drizzle-kit` `>=0.31.0` is optional and only needed to apply migrations. Node.js 18 or newer.

Put the definitions in the same files your `drizzle.config.ts` `schema` already points at, and export them. The CLI reads that config (dialect, schema, `out`, `casing`, `breakpoints`, `migrations.prefix`).

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate && drizzle-pg-extras generate",
    "db:check": "drizzle-pg-extras check",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

`drizzle-pg-extras check` exits 1 when a definition changed and no migration was written. Use it in CI.

Run `drizzle-kit generate` first when a trigger or comment targets a table. The table migration has to land above the trigger migration in the journal. Extensions that a column type depends on (PostGIS, for example) are the opposite: that `CREATE EXTENSION` has to run before the table migration. On a new project, generate the extension migration before the first `drizzle-kit generate`, then add triggers and generate again. This package only appends migrations. It will not insert one in front of a migration you have already committed.

## What gets written

For the stable drizzle-kit 0.31 layout:

```text
drizzle/
  0001_pg_extras.sql          applied by drizzle-kit migrate
  0001_pg_extras.down.sql     not applied by drizzle-kit
  _pg-extras.json             full extras snapshot, commit this
  meta/_journal.json          one new entry, same shape kit writes
  meta/0001_snapshot.json     copy of the previous kit snapshot
```

The kit snapshot is copied the way `drizzle-kit generate --custom` copies it (new id, `prevId` pointing at the previous snapshot, schema body unchanged). A later `drizzle-kit generate` still diffs your tables, not these extras. `_pg-extras.json` sits outside `meta/` so kit does not try to parse it as a schema snapshot.

Up SQL is split on `--> statement-breakpoint`, which is what `drizzle-kit migrate` and `migrate()` from `drizzle-orm` expect.

Down SQL is the reverse diff: restore the previous function body, drop a trigger that was added, `COMMENT … IS NULL` for a comment that was removed. `drizzle-kit migrate` does not run `.down.sql`, and applying it does not delete the row in `__drizzle_migrations`. To roll back, run the down file yourself, then remove that journal entry and the matching migration row if kit's history should forget it too.

If the migrations folder is already the v1 shape (timestamp directories that each contain `migration.sql`), `generate` writes another directory with `migration.sql`, `down.sql`, and a copied `snapshot.json`. That path is best-effort. rc.5 stores later snapshots as deltas; copying a delta forward can confuse the next `drizzle-kit generate`. The layout covered by the tests is the 0.31 journal.

## Programmatic API

```ts
import { defineExtras, generate, pgExtension, pgFunction, pgTrigger, renderIdempotent } from "drizzle-pg-extras";

const extras = defineExtras({
  extensions: [pgExtension("vector", { schema: "extensions" })],
  functions: [setUpdatedAt],
  triggers: [touchUsers],
  tables: [users], // picks up withComment() on the table and its columns
});

generate({ extras, out: "./drizzle", name: "touch_updated_at" });

// Full idempotent script. See "drizzle-kit push" below.
console.log(renderIdempotent(extras));
```

| Export | Role |
| --- | --- |
| `pgFunction(name, config)` | `plpgsql` or `sql`. Args are `IN` only. `returns` is a SQL type string or a Drizzle column (`users.id`). `searchPath: []` emits `SET search_path TO ''`. |
| `pgTrigger(name, config)` | Bound to a Drizzle table or `{ name, schema }`. `columns` must be columns of that table. `when` can be SQL or `({ OLD, NEW }) => sql\`…\``. `OLD.email` renders as `OLD."email"`. |
| `updatedAtTrigger(table, column)` | `BEFORE UPDATE` trigger. `column` must be `date`, `time`, or `timestamp`. Tables that share a database column name share one function, `set_<column>`. |
| `pgExtension(name, { schema, version, cascade })` | `CREATE EXTENSION IF NOT EXISTS`, optionally `WITH SCHEMA` and `VERSION`. |
| `withComment(target, text)` | Table, column builder, enum, finished view or materialized view, `pgFunction`, trigger, extension, or an index / `unique` / `check` / `primaryKey` / `foreignKey` builder. Returns the same object. Does not change Drizzle's SQL. |
| `commentOn(target, text)` | Same `COMMENT ON` output for a table, column, enum, view, function, trigger, or extension you already hold. Indexes and constraints use `withComment` inside the table callback. |
| `partitionedTable(table, { method, columns })` | Marks a drizzle-kit table as `RANGE`, `LIST`, or `HASH`. The migration converts the empty table. See [Partitioning](#partitioning). |
| `pgPartition(name, { parent, ...bounds })` | `CREATE TABLE ... PARTITION OF`. Bounds are `from`/`to`, `in`, `modulus`/`remainder`, or `default: true`. |
| `pgAttachPartition(table, { parent, ...bounds })` | `ALTER TABLE ... ATTACH PARTITION` for a table drizzle-kit already created. |
| `pgDetachPartition(table, { parent })` | `ALTER TABLE ... DETACH PARTITION`. The table is kept. |
| `defineExtras` / `collectExtras` | Bundle objects, or scan a module's exports (the CLI does the scan). |
| `generate` / `diffSnapshots` / `snapshotExtras` | Diff against the stored snapshot and write files. |
| `renderIdempotent` | Create-or-replace script for everything currently declared. No drops. |

`casing` from `drizzle.config.ts` is applied to key-named columns (`updatedAt` with `snake_case` becomes `updated_at`), same as drizzle-kit. Explicit database names are left alone.

A function's identity is `schema.name(arg types)`. Two overloads can coexist. A body, volatility, security, or `search_path` change is `CREATE OR REPLACE` (the oid stays, so triggers are left in place). A return type or argument type change is `DROP FUNCTION` plus create, and triggers that call that function are dropped and created around it. Postgres will not `CREATE OR REPLACE` a new return type.

Comments that disappear become `COMMENT … IS NULL`. If the table, column, enum, view, index, or constraint also left the schema, the null comment is omitted: drizzle-kit's migration drops the comment with the object. The same omission applies when this package drops the function, trigger, or extension in the same file. Removing a column that a trigger's `UPDATE OF` or `WHEN` still references takes two generates: change the trigger first, then drop the column. Postgres will not drop the column while the trigger depends on it.

```ts
import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, pgView, serial, text, unique } from "drizzle-orm/pg-core";
import { pgFunction, withComment } from "drizzle-pg-extras";

export const role = withComment(pgEnum("user_role", ["admin", "member"]), "Account role");

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  role: role("role").notNull(),
}, (table) => [
  withComment(index("users_email_idx").on(table.email), "Lookup by email"),
  withComment(unique("users_email_key").on(table.email), "One email"),
  withComment(check("users_email_check", sql`length(${table.email}) > 0`), "Email is not empty"),
]);

export const activeUsers = withComment(
  pgView("active_users", { email: withComment(text("email"), "Visible email") }).as(sql`select email from users`),
  "Users visible to the app",
);

export const setUpdatedAt = withComment(pgFunction("set_updated_at", {
  returns: "trigger",
  language: "plpgsql",
  body: "BEGIN NEW.updated_at = now(); RETURN NEW; END;",
}), "Sets updated_at");
```

`COMMENT ON` is idempotent. A removed comment is `COMMENT … IS NULL`. Run `drizzle-kit generate` before `drizzle-pg-extras generate` when the comment targets an enum, view, index, or constraint, so that object exists before the comment runs. A later `drizzle-kit generate` still reports no schema changes: the comment is not part of the kit snapshot.

## Partitioning

Postgres accepts `PARTITION BY` only on `CREATE TABLE`. There is no `ALTER TABLE ... PARTITION BY`. drizzle-kit has already written a normal `CREATE TABLE` by the time this package runs, and this package does not rewrite that file (that is what `drizzle-partition` does).

`partitionedTable()` takes the other road. You keep the table in the Drizzle schema, so drizzle-kit still owns columns, indexes, and foreign keys. `generate` appends a migration that rebuilds the table as partitioned **when it is empty**, and raises when it has any rows. Run `drizzle-kit generate` first, then `drizzle-pg-extras generate`, then `drizzle-kit migrate`, and load data after that. Doing it in one `drizzle-kit migrate` is the normal case: kit creates the empty table, then this migration converts it, before the application writes rows.

The tradeoff is that conversion is a rebuild, not a flag. It is safe on an empty table and refused on a table that already has data. A helper that emitted the parent `CREATE TABLE` itself would avoid the rebuild, but then the table would have to stay out of drizzle-kit or kit would create it a second time, and this package would have to own later column changes. Keeping the table in the Drizzle schema is the point of fitting the rest of this package.

```ts
import { integer, pgTable, serial, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { partitionedTable, pgAttachPartition, pgPartition } from "drizzle-pg-extras";

export const events = pgTable("events", {
  id: serial("id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  region: text("region").notNull(),
  payload: text("payload").notNull(),
}, (t) => [
  primaryKey({ columns: [t.id, t.createdAt] }),
]);

export const eventsByTime = partitionedTable(events, {
  method: "range", // "list" or "hash"
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
  region: text("region").notNull(),
  payload: text("payload").notNull(),
}, (t) => [
  primaryKey({ columns: [t.id, t.createdAt] }),
]);

export const attachArchive = pgAttachPartition(eventsArchive, {
  parent: events,
  from: ["2020-01-01"],
  to: ["2024-01-01"],
});

// Later, instead of attachArchive:
// export const detachArchive = pgDetachPartition(eventsArchive, { parent: events });
```

`pgPartition` creates a child with `CREATE TABLE ... PARTITION OF`. List bounds use `in: ["en", "en-US"]` (a tuple per row when the key has several columns). Hash bounds use `modulus` and `remainder`. `from: ["MINVALUE"]` and `to: ["MAXVALUE"]` are the range keywords, not strings. Export `partitionedTable()` as well as the children. The CLI only sees what the schema module exports.

Every primary key and unique constraint on a Drizzle table has to include the partition columns. Postgres requires that, and `partitionedTable()` rejects the table when one does not. A `{ name, schema }` parent skips that check because the columns are only strings.

Removing a `pgPartition` drops the child when the child is empty. `onRemove: "detach"` keeps the table and its rows instead. `pgAttachPartition` always detaches on remove, because drizzle-kit still owns that table. `pgDetachPartition` is the explicit form of that detach. Set `onRemove` when you declare the partition. It is written into `_pg-extras.json` the next time a migration is generated. Changing only `onRemove` does not write a migration file.

The statements are idempotent. Running the migration twice is a no-op when the parent is already partitioned the same way and the children are already attached. `renderIdempotent` emits the same create-or-attach script and does not drop partitions you removed from the schema.

The conversion copies columns, defaults, identity, indexes, checks, and column comments with `CREATE TABLE ... (LIKE ... INCLUDING ALL)`, then puts back outgoing and incoming foreign keys, triggers, row level security policies, grants, the table comment, and ownership. `serial` sequences are reassigned with `ALTER SEQUENCE ... OWNED BY` before the old table is dropped, so `nextval` keeps working. Index and constraint names are renamed back to the names drizzle-kit recorded. A later `drizzle-kit generate` still diffs your tables and reports no schema changes.

### Partition limits

- Empty parents only. A table that already has rows is not converted. Move those rows yourself.
- The partition key cannot be changed in place. `generate` throws. It also throws when a child bound changes. Recreating a partition would drop its rows, and this package will not do that quietly. Detach, copy, and attach in a migration you write.
- Hash parents cannot have a `DEFAULT` partition. Postgres rejects it.
- A table you attach has to match the parent already: column order, `NOT NULL`, unique indexes, and check constraints. Postgres checks that at `ATTACH` and the error is Postgres's.
- Views and materialized views that depend on the parent are not rewritten. The migration raises and leaves the table in place. Drop the views first.
- No expression keys such as `PARTITION BY RANGE (date_trunc('month', created_at))`, no sub-partitions, and no tablespaces.
- No `DETACH PARTITION CONCURRENTLY`. `drizzle-kit migrate` runs each migration in a transaction, and `CONCURRENTLY` cannot run there.
- `drizzle-kit push` does not read these definitions. Partition children are real tables kit did not declare, so push can offer to drop them. The supported path is generate, then migrate. If you push anyway, exclude the children with `tablesFilter`.
- A later drizzle-kit migration that drops and recreates the parent (some column type changes) drops the partitions with it. The extras snapshot already says the table is partitioned, so this package will not emit the conversion again. Repair that kit migration by hand.
- Down SQL drops created partitions when they are empty, detaches attached tables, and converts the parent back when it is empty. It raises when a created partition still has rows. `drizzle-kit migrate` does not run the down file.

## drizzle-kit push

`drizzle-kit push` does not read this package and does not run files in the migrations folder. It will not create functions, triggers, comments, extensions, or partitions.

Kit 0.31 has no trigger diff, so push does not drop a trigger it never declared. A push that drops or recreates the table still drops that table's triggers and comments, because Postgres drops them with the table. Functions are not attached to the table and stay. Extensions are not created. An extension that installs its own tables (PostGIS) can show up as relations push wants to delete; set `extensionsFilters: ["postgis"]` in `drizzle.config.ts` for that case. Partition children show up the same way: they are tables in the database that are not in the Drizzle schema, and push can try to drop them. Exclude those names with `tablesFilter` if you push, or don't push.

The supported path is `drizzle-kit generate`, then `drizzle-pg-extras generate`, then `drizzle-kit migrate`. If you use push for tables, apply the extras yourself with `renderIdempotent` (or by running the latest up file) after a push that recreated a table.

## Compatibility

| | |
| --- | --- |
| drizzle-orm | `>=0.36.4`. Tested with 0.45.3. Drizzle 0.45 and v1.0.0-rc.5 still do not generate functions, triggers, comments, extensions, or partitions. |
| drizzle-kit | `>=0.31.0` journal format. Tested with 0.31.11: `migrate` applies the file, and the next `generate` reports no schema changes. |
| drizzle-kit 1.0 rc | Writes a v1 folder when one is already present. Delta snapshots in rc.5 are not rewritten; treat that layout as untested beyond the file names. |
| PostgreSQL | 14 or newer (`CREATE OR REPLACE TRIGGER`). Tested on 16. |
| Node.js | 18 or newer. ESM and CJS builds. |

## What it does not do yet

- Row level security policies. drizzle-kit already generates policies. The partition conversion copies policies that already exist on a parent; it does not author new ones.
- Creating views and materialized views. drizzle-kit does that. This package comments them.
- Constraint triggers, deferrable triggers, and `REFERENCING` transition tables.
- `OUT`, `INOUT`, and `VARIADIC` function arguments. Function comments use the `IN` argument types.
- Comments on policies, sequences, rules, or individual enum labels.
- Comments on a column-level `.unique()`, `.primaryKey()`, or `.references()`. Declare `unique()`, `primaryKey()`, or `foreignKey()` in the extra config and wrap that builder.
- An index whose key is a SQL expression needs an explicit name before it can be commented. drizzle-kit requires that name too.
- `updatedAtTrigger`'s generated function has no comment of its own. Comment the trigger, or declare the function with `pgFunction` and comment that.
- Call `.as()` or `.existing()` before `withComment` on a view, and `.on()` before `withComment` on an index or unique constraint.
- Pulling the live database back into the snapshot. The diff is against `_pg-extras.json`, not `pg_catalog`.
- MySQL, SQLite, and SingleStore.
- Creating the schema named in `WITH SCHEMA`. The schema has to exist (drizzle-kit can create it).
- Clearing an extension version pin, or moving an extension back to "no schema clause". Set the new version or schema explicitly. `ALTER EXTENSION … UPDATE` still depends on that extension shipping a downgrade path.
- Editing migrations that have already been applied. Generate a new file.

## CLI

```text
drizzle-pg-extras generate [--config drizzle.config.ts] [--name touch_updated_at]
drizzle-pg-extras check [--config drizzle.config.ts]
```

## Development

```sh
npm install
npm test
npm run typecheck
npm run lint
```

Unit tests cover SQL generation and the snapshot diff, including comments and partition bounds. `POSTGRES_URL` points the integration tests at a real Postgres. One runs `drizzle-kit migrate`, checks that the trigger fires, and that comments on the table, column, enum, view, function, trigger, index, constraint, and extension exist. The partition test checks range, list, and hash routing, attach, the empty-table guard, and the down file. CI uses a Postgres 16 service container.

## License

MIT

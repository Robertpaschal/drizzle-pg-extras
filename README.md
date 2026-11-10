# drizzle-pg-extras

Declare the Postgres objects Drizzle still can't model — functions, triggers, table and column comments, and extensions — in TypeScript next to your Drizzle tables, and turn them into ordinary SQL migration files.

`drizzle-kit migrate` applies those files. This package does not patch Drizzle. If Drizzle later generates the same objects itself, the SQL you already committed stays valid.

## Why

These are open Drizzle requests, and the v1.0.0-rc.5 notes don't add them. [PR #4844](https://github.com/drizzle-team/drizzle-orm/pull/4844) is still unmerged.

| Gap | Request |
| --- | --- |
| `CREATE FUNCTION` / `CREATE TRIGGER` | [drizzle-orm#843](https://github.com/drizzle-team/drizzle-orm/issues/843) |
| `COMMENT ON` table and column | [drizzle-orm#886](https://github.com/drizzle-team/drizzle-orm/issues/886) |
| `CREATE EXTENSION` | [drizzle-orm#2124](https://github.com/drizzle-team/drizzle-orm/issues/2124) |
| Partitioned tables | [drizzle-orm#2854](https://github.com/drizzle-team/drizzle-orm/issues/2854) — not in this version |

Smaller packages already cover one of those pieces each: [`drizzle-triggers`](https://github.com/RagedPanda/drizzle-triggers), [`@onozaty/drizzle-db-comments-generator`](https://github.com/onozaty/drizzle-db-comments-generator), and [`drizzle-partition`](https://github.com/Rezarys/drizzle-partition). This package is the Postgres slice people keep asking to put in one schema: functions, triggers, comments, and extensions.

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
| `withComment(target, text)` | Table, or a column builder such as `text("email")`. Returns the same object. Does not change Drizzle's SQL. |
| `commentOn(tableOrColumn, text)` | Same `COMMENT ON` output, for a column that already belongs to a table. |
| `defineExtras` / `collectExtras` | Bundle objects, or scan a module's exports (the CLI does the scan). |
| `generate` / `diffSnapshots` / `snapshotExtras` | Diff against the stored snapshot and write files. |
| `renderIdempotent` | Create-or-replace script for everything currently declared. No drops. |

`casing` from `drizzle.config.ts` is applied to key-named columns (`updatedAt` with `snake_case` becomes `updated_at`), same as drizzle-kit. Explicit database names are left alone.

A function's identity is `schema.name(arg types)`. Two overloads can coexist. A body, volatility, security, or `search_path` change is `CREATE OR REPLACE` (the oid stays, so triggers are left in place). A return type or argument type change is `DROP FUNCTION` plus create, and triggers that call that function are dropped and created around it. Postgres will not `CREATE OR REPLACE` a new return type.

Comments that disappear become `COMMENT … IS NULL`. If the table or column also left the schema, the drop is omitted: the table migration drops the comment with the column. Removing a column that a trigger's `UPDATE OF` or `WHEN` still references takes two generates: change the trigger first, then drop the column. Postgres will not drop the column while the trigger depends on it.

## drizzle-kit push

`drizzle-kit push` does not read this package and does not run files in the migrations folder. It will not create functions, triggers, comments, or extensions.

Kit 0.31 has no trigger diff, so push does not drop a trigger it never declared. A push that drops or recreates the table still drops that table's triggers and comments, because Postgres drops them with the table. Functions are not attached to the table and stay. Extensions are not created. An extension that installs its own tables (PostGIS) can show up as relations push wants to delete; set `extensionsFilters: ["postgis"]` in `drizzle.config.ts` for that case.

The supported path is `drizzle-kit generate`, then `drizzle-pg-extras generate`, then `drizzle-kit migrate`. If you use push for tables, apply the extras yourself with `renderIdempotent` (or by running the latest up file) after a push that recreated a table.

## Compatibility

| | |
| --- | --- |
| drizzle-orm | `>=0.36.4`. Tested with 0.45.3. v1.0.0-rc.5 does not add functions, triggers, comments, extensions, or partitions. |
| drizzle-kit | `>=0.31.0` journal format. Tested with 0.31.11: `migrate` applies the file, and the next `generate` reports no schema changes. |
| drizzle-kit 1.0 rc | Writes a v1 folder when one is already present. Delta snapshots in rc.5 are not rewritten; treat that layout as untested beyond the file names. |
| PostgreSQL | 14 or newer (`CREATE OR REPLACE TRIGGER`). Tested on 16. |
| Node.js | 18 or newer. ESM and CJS builds. |

## What it does not do yet

- Partitions (`PARTITION BY`, child tables). That is issue #2854 and is left for a later version. `drizzle-partition` rewrites kit's `CREATE TABLE` if you need it now.
- Row level security policies. drizzle-kit already generates policies.
- Views and materialized views.
- Constraint triggers, deferrable triggers, and `REFERENCING` transition tables.
- `OUT`, `INOUT`, and `VARIADIC` function arguments.
- Enum, view, and function comments.
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

Unit tests cover SQL generation and the snapshot diff. `POSTGRES_URL` points the integration test at a real Postgres. It runs `drizzle-kit migrate`, checks that the trigger fires, that the comments and extension exist, and that the down file removes them. CI uses a Postgres 16 service container.

## License

MIT

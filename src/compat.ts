/**
 * Small shims over drizzle-orm internals that moved between 0.x and 1.0.
 *
 * - `Casing` is no longer exported from "drizzle-orm" in 1.0.
 * - `CasingCache` is gone from "drizzle-orm/casing" in 1.0; `toSnakeCase` and
 *   `toCamelCase` are still there in both.
 * - `PgDialect` no longer takes a `casing` option in 1.0 (casing moved to
 *   `pgTableCreator`, so column names are already resolved).
 * - `PgArray` is gone in 1.0; array columns are the base column with `dimensions`.
 * - `column.table` still exists at runtime in 1.0 but is no longer typed.
 *
 * Namespace imports are used on purpose: a named import of an export that does
 * not exist fails at module link time in ESM, so `PgArray` and `CasingCache`
 * can only be probed this way.
 */
import { is } from "drizzle-orm";
import * as casingModule from "drizzle-orm/casing";
import * as pgCore from "drizzle-orm/pg-core";

export type Casing = "snake_case" | "camelCase";

const toSnakeCase = (casingModule as { toSnakeCase: (input: string) => string }).toSnakeCase;
const toCamelCase = (casingModule as { toCamelCase: (input: string) => string }).toCamelCase;

interface NamedColumn {
  name: string;
  keyAsName?: boolean;
}

/**
 * Resolve a column's database name the way drizzle does: a column declared
 * without an explicit name (`keyAsName`) gets the configured casing applied to
 * its key; an explicitly named column keeps its name.
 */
export function columnDbName(column: NamedColumn, casing: Casing | undefined): string {
  if (!column.keyAsName || !casing) return column.name;
  return casing === "snake_case" ? toSnakeCase(column.name) : toCamelCase(column.name);
}

/** Same contract as drizzle 0.x's `CasingCache#getColumnCasing`, for both majors. */
export class ColumnCasing {
  constructor(private readonly casing: Casing | undefined) {}

  getColumnCasing(column: NamedColumn): string {
    return columnDbName(column, this.casing);
  }
}

/** The table or view a column belongs to. Typed in 0.x, untyped (but present) in 1.0. */
export function columnTable(column: object): unknown {
  return (column as { table?: unknown }).table;
}

type ArrayWrapper = { baseColumn: object };
const PgArrayClass = (pgCore as Record<string, unknown>)["PgArray"] as
  | (abstract new (...args: never[]) => ArrayWrapper)
  | undefined;

/** Unwrap 0.x `PgArray` columns to their element column. 1.0 has no wrapper. */
export function unwrapArrayColumn(column: object): object {
  let current = column;
  if (!PgArrayClass) return current;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  while (is(current, PgArrayClass as any)) current = (current as ArrayWrapper).baseColumn;
  return current;
}

/** Options for `new PgDialect()`; 1.0 dropped `casing`, and passing it there is a no-op. */
export function dialectConfig(casing: Casing | undefined): Record<string, unknown> | undefined {
  return casing ? { casing } : undefined;
}

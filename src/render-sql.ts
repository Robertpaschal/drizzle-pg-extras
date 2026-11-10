import { is, SQL, type Casing } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const dialects = new Map<string, PgDialect>();

function dialectFor(casing: Casing | undefined): PgDialect {
  const key = casing ?? "";
  let dialect = dialects.get(key);
  if (!dialect) {
    dialect = new PgDialect(casing ? { casing } : undefined);
    dialects.set(key, dialect);
  }
  return dialect;
}

export function isSqlFragment(value: unknown): value is SQL {
  return is(value, SQL);
}

/** Render a Drizzle `sql` fragment as text, inlining values. DDL cannot take bind parameters. */
export function renderSql(query: SQL, casing?: Casing): string {
  return dialectFor(casing).sqlToQuery(query.inlineParams()).sql;
}

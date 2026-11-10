import { sql, getTableColumns, is, type Casing, type SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
import { PgTable, type AnyPgColumn } from "drizzle-orm/pg-core";
import {
  assertColumnOfTable,
  extrasKind,
  readComment,
  tableIdentity,
  type PgComment,
  type PgExtras,
  type PgFunction,
  type PgTrigger,
  type TriggerArg,
} from "./defs.js";
import { PgExtrasError } from "./errors.js";
import { assertIdentifier, normalizeType, quoteIdent, quoteLiteral } from "./quote.js";
import { isSqlFragment, renderSql } from "./render-sql.js";

export type FunctionArgSnapshot = {
  name: string | null;
  type: string;
  defaultExpr: string | null;
};

export type FunctionSnapshot = {
  id: string;
  name: string;
  schema: string;
  args: FunctionArgSnapshot[];
  returns: string;
  language: "plpgsql" | "sql";
  body: string;
  volatility: "volatile" | "stable" | "immutable";
  security: "invoker" | "definer";
  searchPath: string[] | null;
  strict: boolean;
};

export type TriggerSnapshot = {
  id: string;
  name: string;
  schema: string;
  table: string;
  timing: "before" | "after" | "instead of";
  events: ("insert" | "update" | "delete" | "truncate")[];
  forEach: "row" | "statement";
  columns: string[];
  when: string | null;
  functionSchema: string;
  functionName: string;
  functionArgsSql: string[];
  functionId: string | null;
};

export type ExtensionSnapshot = {
  id: string;
  name: string;
  schema: string | null;
  version: string | null;
  cascade: boolean;
};

export type CommentSnapshot = {
  id: string;
  kind: "table" | "column";
  schema: string;
  table: string;
  column: string | null;
  text: string;
};

export type InventoryTable = {
  schema: string;
  name: string;
  columns: string[];
};

export type Snapshot = {
  version: 1;
  functions: FunctionSnapshot[];
  triggers: TriggerSnapshot[];
  extensions: ExtensionSnapshot[];
  comments: CommentSnapshot[];
  inventory: {
    scanned: boolean;
    tables: InventoryTable[];
  };
};

export function emptySnapshot(): Snapshot {
  return {
    version: 1,
    functions: [],
    triggers: [],
    extensions: [],
    comments: [],
    inventory: { scanned: false, tables: [] },
  };
}

export function functionSignature(schema: string, name: string, argTypes: readonly string[]): string {
  return JSON.stringify([schema, name, argTypes]);
}

export function snapshotExtras(extras: PgExtras, options?: { casing?: Casing }): Snapshot {
  const casing = options?.casing;
  const cache = new CasingCache(casing);
  const nameOf = (column: AnyPgColumn) => cache.getColumnCasing(column);

  const functions: FunctionSnapshot[] = [];
  const fnByObject = new Map<PgFunction, FunctionSnapshot>();
  for (const fn of extras.functions) {
    const snap = snapshotFunction(fn, casing);
    pushFunction(functions, snap);
    fnByObject.set(fn, snap);
  }

  const triggers: TriggerSnapshot[] = [];
  for (const trigger of extras.triggers) {
    const owned = ownedUpdatedAt(trigger, nameOf);
    if (owned) {
      const existing = functions.find((fn) => fn.id === owned.id);
      if (!existing) functions.push(owned);
      else if (!sameFunction(existing, owned)) {
        throw new PgExtrasError(
          `function ${existing.schema}.${existing.name} is generated twice with different bodies. Pass functionName to updatedAtTrigger() to keep them apart`,
        );
      }
    }
    triggers.push(snapshotTrigger(trigger, casing, nameOf, fnByObject, owned));
  }

  const extensions: ExtensionSnapshot[] = [];
  for (const ext of extras.extensions) {
    if (extensions.some((item) => item.id === ext.name)) {
      throw new PgExtrasError(`extension "${ext.name}" is declared more than once`);
    }
    extensions.push({
      id: ext.name,
      name: ext.name,
      schema: ext.schema,
      version: ext.version,
      cascade: ext.cascade,
    });
  }

  const comments: CommentSnapshot[] = [];
  for (const table of extras.tables) {
    const harvested = harvest(table, nameOf);
    if (harvested.table) pushComment(comments, harvested.table);
    for (const column of harvested.columns) pushComment(comments, column);
  }
  for (const comment of extras.comments) pushComment(comments, snapshotComment(comment, nameOf));

  const inventoryTables: InventoryTable[] = extras.tables.map((table) => {
    const identity = tableIdentity(table);
    return {
      schema: identity.schema,
      name: identity.name,
      columns: Object.values(getTableColumns(table))
        .map((column) => nameOf(column))
        .sort(),
    };
  });
  inventoryTables.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));

  functions.sort((a, b) => a.id.localeCompare(b.id));
  triggers.sort((a, b) => a.id.localeCompare(b.id));
  extensions.sort((a, b) => a.id.localeCompare(b.id));
  comments.sort((a, b) => a.id.localeCompare(b.id));

  const triggerIds = new Set<string>();
  for (const trigger of triggers) {
    if (triggerIds.has(trigger.id)) {
      throw new PgExtrasError(`trigger "${trigger.name}" is declared more than once on ${trigger.schema}.${trigger.table}`);
    }
    triggerIds.add(trigger.id);
  }

  return {
    version: 1,
    functions,
    triggers,
    extensions,
    comments,
    inventory: { scanned: true, tables: inventoryTables },
  };
}

function pushFunction(functions: FunctionSnapshot[], snap: FunctionSnapshot): void {
  const existing = functions.find((fn) => fn.id === snap.id);
  if (!existing) {
    functions.push(snap);
    return;
  }
  if (!sameFunction(existing, snap)) {
    throw new PgExtrasError(`function ${snap.schema}.${snap.name}(${snap.args.map((arg) => arg.type).join(", ")}) is declared twice with different definitions`);
  }
}

function pushComment(comments: CommentSnapshot[], snap: CommentSnapshot): void {
  const existing = comments.find((comment) => comment.id === snap.id);
  if (!existing) {
    comments.push(snap);
    return;
  }
  if (existing.text !== snap.text) {
    const target = snap.kind === "table" ? `${snap.schema}.${snap.table}` : `${snap.schema}.${snap.table}.${snap.column}`;
    throw new PgExtrasError(`comment on ${target} is declared twice with different text`);
  }
}

function snapshotFunction(fn: PgFunction, casing: Casing | undefined): FunctionSnapshot {
  const args = fn.args.map((arg) => ({
    name: arg.name ?? null,
    type: typeOf(arg.type),
    defaultExpr: arg.default ?? null,
  }));
  const body = normalizeBody(fn.body, casing);
  return {
    id: functionSignature(fn.schema, fn.name, args.map((arg) => arg.type)),
    name: fn.name,
    schema: fn.schema,
    args,
    returns: typeOf(fn.returns),
    language: fn.language,
    body,
    volatility: fn.volatility,
    security: fn.security,
    searchPath: fn.searchPath ? [...fn.searchPath] : null,
    strict: fn.strict,
  };
}

function ownedUpdatedAt(trigger: PgTrigger, nameOf: (column: AnyPgColumn) => string): FunctionSnapshot | null {
  if (!trigger.updatedAt) return null;
  const column = trigger.updatedAt.column;
  const dbName = nameOf(column);
  const schema = trigger.updatedAt.schema ?? "public";
  const name = trigger.updatedAt.functionName ?? `set_${dbName}`;
  assertIdentifier("function", name);
  assertIdentifier("function schema", schema);
  const body = `BEGIN\n  NEW.${quoteIdent(dbName)} = now();\n  RETURN NEW;\nEND;`;
  return {
    id: functionSignature(schema, name, []),
    name,
    schema,
    args: [],
    returns: "trigger",
    language: "plpgsql",
    body,
    volatility: "volatile",
    security: "invoker",
    searchPath: null,
    strict: false,
  };
}

function snapshotTrigger(
  trigger: PgTrigger,
  casing: Casing | undefined,
  nameOf: (column: AnyPgColumn) => string,
  fnByObject: Map<PgFunction, FunctionSnapshot>,
  owned: FunctionSnapshot | null,
): TriggerSnapshot {
  const identity = tableIdentity(trigger.table);
  const dbColumns = trigger.columns.map((column) => {
    if (typeof column === "string") return column;
    return nameOf(column);
  });
  const uniqueColumns = [...new Set(dbColumns)].sort();
  let functionSchema: string;
  let functionName: string;
  let functionId: string | null;
  if (owned) {
    functionSchema = owned.schema;
    functionName = owned.name;
    functionId = owned.id;
  } else if (trigger.function && extrasKind(trigger.function) === "function") {
    const snap = fnByObject.get(trigger.function as PgFunction) ?? snapshotFunction(trigger.function as PgFunction, casing);
    functionSchema = snap.schema;
    functionName = snap.name;
    functionId = snap.id;
  } else if (trigger.function && "name" in trigger.function) {
    functionName = trigger.function.name;
    functionSchema = trigger.function.schema ?? "public";
    assertIdentifier("function", functionName);
    assertIdentifier("function schema", functionSchema);
    functionId = null;
  } else {
    throw new PgExtrasError("trigger is missing a function");
  }
  const name = trigger.name ?? `${identity.name}_set_${uniqueColumns[0] ?? nameOf(trigger.updatedAt!.column)}`;
  assertIdentifier("trigger", name);
  const when = renderWhen(trigger, casing);
  return {
    id: JSON.stringify(["trigger", identity.schema, identity.name, name]),
    name,
    schema: identity.schema,
    table: identity.name,
    timing: trigger.timing,
    events: [...trigger.events],
    forEach: trigger.forEach,
    columns: uniqueColumns,
    when,
    functionSchema,
    functionName,
    functionArgsSql: trigger.args.map((arg) => renderTriggerArg(arg, casing, nameOf)),
    functionId,
  };
}

function renderWhen(trigger: PgTrigger, casing: Casing | undefined): string | null {
  if (!trigger.when) return null;
  let value: SQL | string;
  if (typeof trigger.when === "function") {
    if (!is(trigger.table, PgTable)) {
      throw new PgExtrasError("WHEN callback needs a Drizzle table so NEW and OLD can be typed");
    }
    const refs = {
      NEW: rowProxy(trigger.table, "NEW", casing),
      OLD: rowProxy(trigger.table, "OLD", casing),
    };
    value = trigger.when(refs);
  } else {
    value = trigger.when;
  }
  const text = (typeof value === "string" ? value : renderSql(value, casing)).trim().replace(/;+\s*$/, "");
  if (text.length === 0) return null;
  if (text.includes(";")) {
    throw new PgExtrasError(`trigger WHEN clause cannot contain ";"`);
  }
  return text;
}

function rowProxy(table: PgTable, alias: "NEW" | "OLD", casing: Casing | undefined): Record<string, SQL> {
  const cache = new CasingCache(casing);
  const refs: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    refs[key] = rawSql(`${alias}.${quoteIdent(cache.getColumnCasing(column))}`);
  }
  return refs;
}

function rawSql(text: string): SQL {
  return sql.raw(text);
}

function renderTriggerArg(arg: TriggerArg, casing: Casing | undefined, nameOf: (column: AnyPgColumn) => string): string {
  if (typeof arg === "string") return quoteLiteral(arg);
  if (typeof arg === "number") {
    if (!Number.isFinite(arg)) throw new PgExtrasError("trigger argument must be a finite number");
    return String(arg);
  }
  if (typeof arg === "boolean") return arg ? "TRUE" : "FALSE";
  if (isSqlFragment(arg)) {
    const text = renderSql(arg, casing).trim();
    if (text.includes(";")) throw new PgExtrasError('trigger argument SQL cannot contain ";"');
    return text;
  }
  if (typeof arg === "object" && arg && "getSQLType" in arg) {
    return quoteLiteral(nameOf(arg as AnyPgColumn));
  }
  throw new PgExtrasError("trigger argument must be a string, number, boolean, column, or sql fragment");
}

function typeOf(type: PgFunction["returns"]): string {
  if (typeof type === "string") return normalizeType(type);
  return normalizeType(type.getSQLType());
}

function normalizeBody(body: string | SQL, casing: Casing | undefined): string {
  const text = typeof body === "string" ? body : renderSql(body, casing);
  return text.replace(/^\n+/, "").replace(/\s+$/, "");
}

function harvest(table: PgTable, nameOf: (column: AnyPgColumn) => string): { table: CommentSnapshot | null; columns: CommentSnapshot[] } {
  const identity = tableIdentity(table);
  const columns: CommentSnapshot[] = [];
  for (const column of Object.values(getTableColumns(table))) {
    const text = readComment(column);
    if (!text) continue;
    const dbName = nameOf(column);
    columns.push({
      id: JSON.stringify(["column", identity.schema, identity.name, dbName]),
      kind: "column",
      schema: identity.schema,
      table: identity.name,
      column: dbName,
      text,
    });
  }
  const tableText = readComment(table);
  return {
    table: tableText
      ? {
          id: JSON.stringify(["table", identity.schema, identity.name, null]),
          kind: "table",
          schema: identity.schema,
          table: identity.name,
          column: null,
          text: tableText,
        }
      : null,
    columns,
  };
}

function snapshotComment(comment: PgComment, nameOf: (column: AnyPgColumn) => string): CommentSnapshot {
  if (is(comment.target, PgTable)) {
    const identity = tableIdentity(comment.target);
    return {
      id: JSON.stringify(["table", identity.schema, identity.name, null]),
      kind: "table",
      schema: identity.schema,
      table: identity.name,
      column: null,
      text: comment.text,
    };
  }
  const column = comment.target;
  if (!column.table || !is(column.table, PgTable)) {
    throw new PgExtrasError(`commentOn() column "${column.name}" is not attached to a Postgres table`);
  }
  assertColumnOfTable(column.table, column);
  const identity = tableIdentity(column.table);
  const dbName = nameOf(column);
  return {
    id: JSON.stringify(["column", identity.schema, identity.name, dbName]),
    kind: "column",
    schema: identity.schema,
    table: identity.name,
    column: dbName,
    text: comment.text,
  };
}

export function sameFunction(a: FunctionSnapshot, b: FunctionSnapshot): boolean {
  return JSON.stringify(fnShape(a)) === JSON.stringify(fnShape(b));
}

function fnShape(fn: FunctionSnapshot) {
  return {
    name: fn.name,
    schema: fn.schema,
    args: fn.args,
    returns: fn.returns,
    language: fn.language,
    body: fn.body,
    volatility: fn.volatility,
    security: fn.security,
    searchPath: fn.searchPath,
    strict: fn.strict,
  };
}

export function sameTrigger(a: TriggerSnapshot, b: TriggerSnapshot): boolean {
  return JSON.stringify({ ...a, id: undefined }) === JSON.stringify({ ...b, id: undefined });
}

export function parseSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== "object") throw new PgExtrasError("pg extras snapshot is not an object");
  const record = value as Partial<Snapshot>;
  if (record.version !== 1) throw new PgExtrasError(`pg extras snapshot version ${String(record.version)} is not supported`);
  return {
    version: 1,
    functions: record.functions ?? [],
    triggers: record.triggers ?? [],
    extensions: record.extensions ?? [],
    comments: record.comments ?? [],
    inventory: record.inventory ?? { scanned: false, tables: [] },
  };
}

import {
  Column,
  ColumnBuilder,
  getTableColumns,
  is,
  Table,
  type ColumnBuilderBase,
  type SQL,
} from "drizzle-orm";
import { getTableConfig, PgTable, type AnyPgColumn } from "drizzle-orm/pg-core";
import { PgExtrasError } from "./errors.js";
import { assertIdentifier } from "./quote.js";

const KIND = Symbol.for("drizzle-pg-extras.kind");
const COMMENT = Symbol.for("drizzle-pg-extras.comment");

export type ExtrasKind = "function" | "trigger" | "extension" | "comment";

export type PgLanguage = "plpgsql" | "sql";
export type PgVolatility = "volatile" | "stable" | "immutable";
export type PgSecurity = "invoker" | "definer";
export type TriggerTiming = "before" | "after" | "instead of";
export type TriggerEvent = "insert" | "update" | "delete" | "truncate";
export type TriggerForEach = "row" | "statement";

const EVENT_ORDER: readonly TriggerEvent[] = ["insert", "update", "delete", "truncate"];

export type PgType = string | AnyPgColumn;

export type PgFunctionArg = {
  name?: string;
  type: PgType;
  /** SQL expression, such as `0` or `'pending'`. Not a bind parameter. */
  default?: string;
};

export type PgFunctionConfig = {
  schema?: string;
  args?: readonly PgFunctionArg[];
  returns: PgType;
  language?: PgLanguage;
  body: string | SQL;
  volatility?: PgVolatility;
  security?: PgSecurity;
  /**
   * Pins `search_path` for the function. `[]` emits `SET search_path TO ''`.
   * Set this when `security` is `"definer"`.
   */
  searchPath?: readonly string[];
  strict?: boolean;
};

export type PgFunction = {
  readonly [KIND]: "function";
  readonly name: string;
  readonly schema: string;
  readonly args: readonly PgFunctionArg[];
  readonly returns: PgType;
  readonly language: PgLanguage;
  readonly body: string | SQL;
  readonly volatility: PgVolatility;
  readonly security: PgSecurity;
  readonly searchPath: readonly string[] | null;
  readonly strict: boolean;
};

export type RowRefs<TTable extends PgTable> = {
  [K in keyof TTable["_"]["columns"]]: SQL;
};

export type TriggerArg = string | number | boolean | AnyPgColumn | SQL;

export type FunctionCall = PgFunction | { name: string; schema?: string };

type UpdatedAtSource = {
  column: AnyPgColumn;
  functionName?: string;
  schema?: string;
};

export type PgTrigger = {
  readonly [KIND]: "trigger";
  readonly name: string | null;
  readonly table: PgTable | { name: string; schema?: string };
  readonly timing: TriggerTiming;
  readonly events: readonly TriggerEvent[];
  readonly forEach: TriggerForEach;
  readonly columns: readonly (AnyPgColumn | string)[];
  readonly when: WhenInput | null;
  readonly function: FunctionCall | null;
  readonly args: readonly TriggerArg[];
  readonly updatedAt: UpdatedAtSource | null;
};

type WhenInput =
  | string
  | SQL
  | ((refs: { NEW: Record<string, SQL>; OLD: Record<string, SQL> }) => SQL | string);

export type PgExtension = {
  readonly [KIND]: "extension";
  readonly name: string;
  readonly schema: string | null;
  readonly version: string | null;
  readonly cascade: boolean;
};

export type PgComment = {
  readonly [KIND]: "comment";
  readonly target: PgTable | AnyPgColumn;
  readonly text: string;
};

export type PgExtras = {
  functions: PgFunction[];
  triggers: PgTrigger[];
  extensions: PgExtension[];
  comments: PgComment[];
  tables: PgTable[];
};

function brand<T extends object, K extends ExtrasKind>(value: T, kind: K): T & { readonly [KIND]: K } {
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });
  return value as T & { readonly [KIND]: K };
}

export function extrasKind(value: unknown): ExtrasKind | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { [KIND]?: unknown })[KIND];
  if (kind === "function" || kind === "trigger" || kind === "extension" || kind === "comment") return kind;
  return null;
}

function requireComment(comment: string, where: string): string {
  if (typeof comment !== "string" || comment.trim().length === 0) {
    throw new PgExtrasError(`${where} requires a non-empty comment`);
  }
  if (comment.includes("\0")) {
    throw new PgExtrasError(`${where} comment contains a null byte`);
  }
  return comment.trim();
}

function stampConfig(target: object, comment: string): void {
  const config = (target as { config?: Record<symbol, unknown> }).config;
  if (!config || typeof config !== "object") {
    throw new PgExtrasError("withComment() could not attach a column comment");
  }
  config[COMMENT] = comment;
}

/**
 * Attach a Postgres comment to a Drizzle table or column builder and return it unchanged.
 * Column comments are stored on the builder config object Drizzle copies onto the built column,
 * so query building and `drizzle-kit` diffs are unchanged.
 *
 * Wrap the column builder (`text("email")`), not a column already read back off the table.
 * For an existing column, use {@link commentOn}.
 */
export function withComment<T extends Table>(target: T, comment: string): T;
export function withComment<T extends ColumnBuilderBase>(target: T, comment: string): T;
export function withComment<T extends Column>(target: T, comment: string): T;
export function withComment(target: unknown, comment: string): unknown {
  const text = requireComment(comment, "withComment()");
  if (is(target, Table)) {
    (target as unknown as Record<symbol, unknown>)[COMMENT] = text;
    return target;
  }
  if (is(target, Column) || is(target, ColumnBuilder)) {
    stampConfig(target as object, text);
    return target;
  }
  throw new PgExtrasError(
    'withComment() takes a Drizzle table or a column builder such as text("email"). Enum comments are not in v0.1. For a column that already belongs to a table, use commentOn().',
  );
}

export function readComment(target: object): string | undefined {
  const direct = (target as Record<symbol, unknown>)[COMMENT];
  if (typeof direct === "string") return direct;
  const config = (target as { config?: Record<symbol, unknown> }).config;
  const stamped = config?.[COMMENT];
  return typeof stamped === "string" ? stamped : undefined;
}

export function pgFunction(name: string, config: PgFunctionConfig): PgFunction {
  assertIdentifier("function", name);
  const schema = config.schema ?? "public";
  assertIdentifier("function schema", schema);
  const language = config.language ?? "plpgsql";
  if (language !== "plpgsql" && language !== "sql") {
    throw new PgExtrasError(`pgFunction("${name}"): language must be "plpgsql" or "sql"`);
  }
  if (config.body === undefined || config.body === null || (typeof config.body === "string" && config.body.trim() === "")) {
    throw new PgExtrasError(`pgFunction("${name}"): body is empty`);
  }
  const args = config.args ?? [];
  const seen = new Set<string>();
  for (const arg of args) {
    if (arg.name !== undefined) {
      assertIdentifier(`pgFunction("${name}") argument`, arg.name);
      if (seen.has(arg.name)) throw new PgExtrasError(`pgFunction("${name}"): duplicate argument "${arg.name}"`);
      seen.add(arg.name);
    }
    if (arg.default !== undefined && arg.default.includes(";")) {
      throw new PgExtrasError(`pgFunction("${name}"): argument default cannot contain ";"`);
    }
    if (typeof arg.type === "string" && arg.type.trim() === "") {
      throw new PgExtrasError(`pgFunction("${name}"): argument type is empty`);
    }
  }
  return brand(
    {
      name,
      schema,
      args,
      returns: config.returns,
      language,
      body: config.body,
      volatility: config.volatility ?? "volatile",
      security: config.security ?? "invoker",
      searchPath: config.searchPath ? [...config.searchPath] : null,
      strict: config.strict ?? false,
    },
    "function",
  );
}

type TableTriggerConfig<TTable extends PgTable> = {
  table: TTable;
  timing: "before" | "after";
  events: readonly TriggerEvent[];
  forEach?: TriggerForEach;
  columns?: readonly (TTable["_"]["columns"][keyof TTable["_"]["columns"]] | string)[];
  when?: string | SQL | ((refs: { NEW: RowRefs<TTable>; OLD: RowRefs<TTable> }) => SQL | string);
  function: FunctionCall;
  args?: readonly TriggerArg[];
};

type NameTriggerConfig = {
  table: { name: string; schema?: string };
  timing: TriggerTiming;
  events: readonly TriggerEvent[];
  forEach?: TriggerForEach;
  columns?: readonly string[];
  when?: string | SQL;
  function: FunctionCall;
  args?: readonly TriggerArg[];
};

export function pgTrigger<TTable extends PgTable>(name: string, config: TableTriggerConfig<TTable>): PgTrigger;
export function pgTrigger(name: string, config: NameTriggerConfig): PgTrigger;
export function pgTrigger(name: string, config: TableTriggerConfig<PgTable> | NameTriggerConfig): PgTrigger {
  assertIdentifier("trigger", name);
  return finishTrigger(name, config.table, {
    timing: config.timing,
    events: config.events,
    forEach: config.forEach,
    columns: config.columns as readonly (AnyPgColumn | string)[] | undefined,
    when: (config.when ?? null) as WhenInput | null,
    function: config.function,
    args: config.args,
    updatedAt: null,
  });
}

export function updatedAtTrigger<TTable extends PgTable>(
  table: TTable,
  column: TTable["_"]["columns"][keyof TTable["_"]["columns"]],
  options?: { name?: string; functionName?: string; schema?: string },
): PgTrigger {
  if (!is(table, PgTable)) {
    throw new PgExtrasError("updatedAtTrigger() table must be a Drizzle Postgres table");
  }
  assertColumnOfTable(table, column);
  const sqlType = column.getSQLType().toLowerCase();
  if (!(sqlType === "date" || sqlType.startsWith("time"))) {
    throw new PgExtrasError(
      `updatedAtTrigger(): column "${column.name}" is ${column.getSQLType()}. It must be a date, time, or timestamp column`,
    );
  }
  if (options?.name) assertIdentifier("trigger", options.name);
  if (options?.functionName) assertIdentifier("function", options.functionName);
  if (options?.schema) assertIdentifier("function schema", options.schema);
  return finishTrigger(options?.name ?? null, table, {
    timing: "before",
    events: ["update"],
    forEach: "row",
    columns: [],
    when: null,
    function: null,
    args: [],
    updatedAt: { column, functionName: options?.functionName, schema: options?.schema },
  });
}

function finishTrigger(
  name: string | null,
  table: PgTable | { name: string; schema?: string },
  config: {
    timing: TriggerTiming;
    events: readonly TriggerEvent[];
    forEach?: TriggerForEach;
    columns?: readonly (AnyPgColumn | string)[];
    when: WhenInput | null;
    function: FunctionCall | null;
    args?: readonly TriggerArg[];
    updatedAt: UpdatedAtSource | null;
  },
): PgTrigger {
  const label = name ?? "updated-at trigger";
  if (!config.events || config.events.length === 0) {
    throw new PgExtrasError(`pgTrigger("${label}"): events must include at least one event`);
  }
  const events = EVENT_ORDER.filter((event) => config.events.includes(event));
  if (events.length !== new Set(config.events).size) {
    throw new PgExtrasError(`pgTrigger("${label}"): unknown trigger event`);
  }
  const forEach = config.forEach ?? "row";
  if (events.includes("truncate") && forEach === "row") {
    throw new PgExtrasError(`pgTrigger("${label}"): truncate requires forEach: "statement"`);
  }
  if (config.timing === "instead of") {
    if (is(table, PgTable)) {
      throw new PgExtrasError(
        `pgTrigger("${label}"): INSTEAD OF is for views. Pass { name, schema } for a view, or use before/after on a table`,
      );
    }
    if (forEach !== "row") {
      throw new PgExtrasError(`pgTrigger("${label}"): INSTEAD OF requires forEach: "row"`);
    }
    if (events.includes("truncate")) {
      throw new PgExtrasError(`pgTrigger("${label}"): INSTEAD OF cannot include truncate`);
    }
  }
  const columns = config.columns ?? [];
  if (columns.length > 0 && !events.includes("update")) {
    throw new PgExtrasError(`pgTrigger("${label}"): columns only apply to the update event`);
  }
  if (is(table, PgTable)) {
    for (const column of columns) {
      if (typeof column !== "string") assertColumnOfTable(table, column);
    }
  } else {
    for (const column of columns) {
      if (typeof column !== "string") {
        throw new PgExtrasError(`pgTrigger("${label}"): columns on a { name, schema } table must be database column name strings`);
      }
    }
    assertIdentifier("table", table.name);
    if (table.schema) assertIdentifier("table schema", table.schema);
  }
  const fn = config.function;
  if (fn && extrasKind(fn) === "function") {
    const defined = fn as PgFunction;
    const returns = typeof defined.returns === "string" ? defined.returns.trim().toLowerCase() : defined.returns.getSQLType().toLowerCase();
    if (returns !== "trigger") {
      throw new PgExtrasError(`pgTrigger("${label}"): function "${defined.name}" returns ${returns}, not trigger`);
    }
    const argCount = config.args?.length ?? 0;
    if (defined.args.length !== argCount) {
      throw new PgExtrasError(
        `pgTrigger("${label}"): function "${defined.name}" has ${defined.args.length} argument(s), but the trigger passes ${argCount}`,
      );
    }
  } else if (!fn && !config.updatedAt) {
    throw new PgExtrasError(`pgTrigger("${label}"): function is required`);
  }
  return brand(
    {
      name,
      table,
      timing: config.timing,
      events,
      forEach,
      columns,
      when: config.when,
      function: fn,
      args: config.args ?? [],
      updatedAt: config.updatedAt,
    },
    "trigger",
  );
}

export function pgExtension(
  name: string,
  options?: { schema?: string; version?: string; cascade?: boolean },
): PgExtension {
  assertIdentifier("extension", name);
  if (options?.schema) assertIdentifier("extension schema", options.schema);
  if (options?.version !== undefined && options.version.trim() === "") {
    throw new PgExtrasError(`pgExtension("${name}"): version is empty`);
  }
  return brand(
    {
      name: name.toLowerCase(),
      schema: options?.schema ?? null,
      version: options?.version ?? null,
      cascade: options?.cascade ?? false,
    },
    "extension",
  );
}

/** A table or column comment that is not attached with {@link withComment}. */
export function commentOn(target: PgTable, text: string): PgComment;
export function commentOn(target: AnyPgColumn, text: string): PgComment;
export function commentOn(target: PgTable | AnyPgColumn, text: string): PgComment {
  const comment = requireComment(text, "commentOn()");
  if (!is(target, PgTable) && !is(target, Column)) {
    throw new PgExtrasError("commentOn() takes a Drizzle Postgres table or column");
  }
  return brand({ target: target as PgTable | AnyPgColumn, text: comment }, "comment");
}

export function assertColumnOfTable(table: PgTable, column: AnyPgColumn): void {
  const columns = Object.values(getTableColumns(table));
  if (!columns.includes(column)) {
    throw new PgExtrasError(
      `column "${column.name}" does not belong to table "${getTableConfig(table).name}"`,
    );
  }
}

export function tableIdentity(table: PgTable | { name: string; schema?: string }): { schema: string; name: string } {
  if (is(table, PgTable)) {
    const config = getTableConfig(table);
    return { schema: config.schema && config.schema.length > 0 ? config.schema : "public", name: config.name };
  }
  return { schema: table.schema && table.schema.length > 0 ? table.schema : "public", name: table.name };
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

import {
  Column,
  ColumnBuilder,
  getTableColumns,
  is,
  Table,
  type ColumnBuilderBase,
  type SQL,
} from "drizzle-orm";
import {
  CheckBuilder,
  ForeignKeyBuilder,
  IndexBuilder,
  IndexBuilderOn,
  ManualMaterializedViewBuilder,
  ManualViewBuilder,
  MaterializedViewBuilder,
  PgTable,
  PrimaryKeyBuilder,
  UniqueConstraintBuilder,
  UniqueOnConstraintBuilder,
  ViewBuilder,
  getTableConfig,
  isPgEnum,
  isPgMaterializedView,
  isPgView,
  type AnyPgColumn,
  type PgEnum,
  type PgEnumObject,
  type PgMaterializedView,
  type PgView,
} from "drizzle-orm/pg-core";
import { PgExtrasError } from "./errors.js";
import { assertIdentifier } from "./quote.js";

const KIND = Symbol.for("drizzle-pg-extras.kind");
const COMMENT = Symbol.for("drizzle-pg-extras.comment");

export type ExtrasKind =
  | "function"
  | "trigger"
  | "extension"
  | "comment"
  | "partitionedTable"
  | "partition"
  | "detach";

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

/**
 * Either `pgEnum` form. A structural type so a specific `pgEnum("role", ["a"])`
 * still assigns; Drizzle's enum generics are invariant.
 */
export type AnyPgEnum = {
  readonly enumName: string;
  readonly enumValues: readonly string[];
  readonly schema?: string;
};

export type PgViewLike = PgView | PgMaterializedView;

export type PgCommentTarget =
  | PgTable
  | AnyPgColumn
  | AnyPgEnum
  | PgViewLike
  | PgFunction
  | PgTrigger
  | PgExtension;

export type PgComment = {
  readonly [KIND]: "comment";
  readonly target: PgCommentTarget;
  readonly text: string;
};

export type PartitionMethod = "range" | "list" | "hash";

/** A bound written into `FOR VALUES`. `MINVALUE` and `MAXVALUE` are range keywords, not strings. */
export type PartitionBound = string | number | boolean | null | bigint | "MINVALUE" | "MAXVALUE";

export type PartitionParent = PgTable | PartitionedTable | { name: string; schema?: string };

export type PartitionBoundSpec =
  | { kind: "range"; from: readonly PartitionBound[]; to: readonly PartitionBound[] }
  | { kind: "list"; values: readonly (PartitionBound | readonly PartitionBound[])[] }
  | { kind: "hash"; modulus: number; remainder: number }
  | { kind: "default" };

export type PartitionedTable = {
  readonly [KIND]: "partitionedTable";
  readonly table: PgTable | { name: string; schema?: string };
  readonly method: PartitionMethod;
  readonly columns: readonly (AnyPgColumn | string)[];
};

export type PgPartition = {
  readonly [KIND]: "partition";
  readonly name: string;
  readonly schema: string | null;
  readonly parent: PartitionParent;
  readonly mode: "create" | "attach";
  /** Used when this declaration is removed. `drop` deletes the child. `detach` keeps the table. */
  readonly onRemove: "drop" | "detach";
  readonly bound: PartitionBoundSpec;
};

export type PgDetach = {
  readonly [KIND]: "detach";
  readonly table: PgTable | { name: string; schema?: string };
  readonly parent: PartitionParent;
};

export type PgExtras = {
  functions: PgFunction[];
  triggers: PgTrigger[];
  extensions: PgExtension[];
  comments: PgComment[];
  tables: PgTable[];
  enums: AnyPgEnum[];
  views: PgViewLike[];
  partitionedTables: PartitionedTable[];
  partitions: PgPartition[];
  detaches: PgDetach[];
};

function brand<T extends object, K extends ExtrasKind>(value: T, kind: K): T & { readonly [KIND]: K } {
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });
  return value as T & { readonly [KIND]: K };
}

export function extrasKind(value: unknown): ExtrasKind | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = (value as { [KIND]?: unknown })[KIND];
  if (
    kind === "function" ||
    kind === "trigger" ||
    kind === "extension" ||
    kind === "comment" ||
    kind === "partitionedTable" ||
    kind === "partition" ||
    kind === "detach"
  ) {
    return kind;
  }
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
 * Attach a Postgres comment and return the same object.
 * Column comments are stored on the builder config Drizzle copies onto the built column,
 * so query building and `drizzle-kit` diffs are unchanged. The same is true for indexes
 * and constraints: the comment lives on the builder, which the table callback creates
 * again each time drizzle-kit reads the schema.
 *
 * Wrap a column builder (`text("email")`), not a column already read back off the table.
 * For an existing column, enum, view, function, trigger, or extension, use {@link commentOn}.
 * Call `.as()` or `.existing()` before commenting a view, and `.on()` before commenting an index or unique constraint.
 */
export function withComment<T extends Table>(target: T, comment: string): T;
export function withComment<T extends ColumnBuilderBase>(target: T, comment: string): T;
export function withComment<T extends Column>(target: T, comment: string): T;
export function withComment<T extends PgEnum<[string, ...string[]]>>(target: T, comment: string): T;
export function withComment<T extends PgEnumObject<object>>(target: T, comment: string): T;
export function withComment<T extends PgView>(target: T, comment: string): T;
export function withComment<T extends PgMaterializedView>(target: T, comment: string): T;
export function withComment<T extends PgFunction>(target: T, comment: string): T;
export function withComment<T extends PgTrigger>(target: T, comment: string): T;
export function withComment<T extends PgExtension>(target: T, comment: string): T;
export function withComment<T extends IndexBuilder>(target: T, comment: string): T;
export function withComment<T extends UniqueConstraintBuilder>(target: T, comment: string): T;
export function withComment<T extends CheckBuilder>(target: T, comment: string): T;
export function withComment<T extends ForeignKeyBuilder>(target: T, comment: string): T;
export function withComment<T extends PrimaryKeyBuilder>(target: T, comment: string): T;
export function withComment(target: unknown, comment: string): unknown {
  const text = requireComment(comment, "withComment()");
  if (is(target, Table)) {
    stampDirect(target, text);
    return target;
  }
  if (is(target, Column) || is(target, ColumnBuilder)) {
    stampConfig(target, text);
    return target;
  }
  if (isEnumTarget(target) || isPgView(target) || isPgMaterializedView(target)) {
    stampDirect(target, text);
    return target;
  }
  const kind = extrasKind(target);
  if (kind === "function" || kind === "trigger" || kind === "extension") {
    stampDirect(target as object, text);
    return target;
  }
  if (
    is(target, IndexBuilder) ||
    is(target, UniqueConstraintBuilder) ||
    is(target, CheckBuilder) ||
    is(target, ForeignKeyBuilder) ||
    is(target, PrimaryKeyBuilder)
  ) {
    stampDirect(target, text);
    return target;
  }
  if (is(target, IndexBuilderOn) || is(target, UniqueOnConstraintBuilder)) {
    throw new PgExtrasError('withComment() on an index or unique constraint needs .on(...) first');
  }
  if (
    is(target, ViewBuilder) ||
    is(target, ManualViewBuilder) ||
    is(target, MaterializedViewBuilder) ||
    is(target, ManualMaterializedViewBuilder)
  ) {
    throw new PgExtrasError("withComment() on a view needs .as() or .existing() first");
  }
  throw new PgExtrasError(
    'withComment() takes a table, column, enum, view, materialized view, function, trigger, extension, index, or constraint. For a column that already belongs to a table, use commentOn().',
  );
}

function stampDirect(target: object, text: string): void {
  Object.defineProperty(target, COMMENT, {
    value: text,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function isEnumTarget(target: unknown): target is AnyPgEnum {
  return isPgEnum(target);
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

/**
 * A comment that is not attached with {@link withComment}.
 * Indexes and constraints are recreated whenever the table config runs, so comment those
 * with `withComment` on the builder inside the extra-config callback.
 */
export function commentOn(target: PgTable, text: string): PgComment;
export function commentOn(target: AnyPgColumn, text: string): PgComment;
export function commentOn<TValues extends [string, ...string[]]>(target: PgEnum<TValues>, text: string): PgComment;
export function commentOn<TValues extends object>(target: PgEnumObject<TValues>, text: string): PgComment;
export function commentOn(target: PgView, text: string): PgComment;
export function commentOn(target: PgMaterializedView, text: string): PgComment;
export function commentOn(target: PgFunction, text: string): PgComment;
export function commentOn(target: PgTrigger, text: string): PgComment;
export function commentOn(target: PgExtension, text: string): PgComment;
export function commentOn(target: PgCommentTarget, text: string): PgComment {
  const comment = requireComment(text, "commentOn()");
  if (isCommentTarget(target)) {
    return brand({ target, text: comment }, "comment");
  }
  if (
    is(target, IndexBuilder) ||
    is(target, IndexBuilderOn) ||
    is(target, UniqueConstraintBuilder) ||
    is(target, UniqueOnConstraintBuilder) ||
    is(target, CheckBuilder) ||
    is(target, ForeignKeyBuilder) ||
    is(target, PrimaryKeyBuilder)
  ) {
    throw new PgExtrasError(
      "commentOn() does not take an index or constraint. Wrap the builder with withComment() inside the table extra config.",
    );
  }
  throw new PgExtrasError("commentOn() takes a table, column, enum, view, materialized view, function, trigger, or extension");
}

function isCommentTarget(target: unknown): target is PgCommentTarget {
  if (is(target, PgTable) || is(target, Column)) return true;
  if (isEnumTarget(target)) return true;
  if (isPgView(target) || isPgMaterializedView(target)) return true;
  const kind = extrasKind(target);
  return kind === "function" || kind === "trigger" || kind === "extension";
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

const PARTITION_METHODS = new Set<PartitionMethod>(["range", "list", "hash"]);

/**
 * Declare that a drizzle-kit table should become partitioned.
 *
 * Postgres only accepts `PARTITION BY` on `CREATE TABLE`. drizzle-kit has already
 * emitted a normal `CREATE TABLE`, so `generate` writes a migration that recreates
 * that table when it is empty and refuses to run once it has rows. The table stays
 * in the Drizzle schema; this package does not emit a second copy of the column list.
 */
export function partitionedTable<TTable extends PgTable>(
  table: TTable,
  config: {
    method: PartitionMethod;
    columns: readonly TTable["_"]["columns"][keyof TTable["_"]["columns"]][];
  },
): PartitionedTable;
export function partitionedTable(
  table: { name: string; schema?: string },
  config: { method: PartitionMethod; columns: readonly string[] },
): PartitionedTable;
export function partitionedTable(
  table: PgTable | { name: string; schema?: string },
  config: { method: PartitionMethod; columns: readonly (AnyPgColumn | string)[] },
): PartitionedTable {
  if (!PARTITION_METHODS.has(config.method)) {
    throw new PgExtrasError('partitionedTable(): method must be "range", "list", or "hash"');
  }
  if (!config.columns || config.columns.length === 0) {
    throw new PgExtrasError("partitionedTable(): columns must include the partition key");
  }
  if (is(table, PgTable)) {
    const seen = new Set<string>();
    const columns: AnyPgColumn[] = [];
    for (const column of config.columns) {
      if (typeof column === "string") {
        throw new PgExtrasError("partitionedTable(): pass columns from the Drizzle table, not name strings");
      }
      assertColumnOfTable(table, column);
      if (seen.has(column.name)) {
        throw new PgExtrasError(`partitionedTable(${getTableConfig(table).name}): duplicate partition column "${column.name}"`);
      }
      seen.add(column.name);
      columns.push(column);
    }
    assertKeyCoveredByUniques(table, columns);
  } else {
    assertIdentifier("table", table.name);
    if (table.schema) assertIdentifier("table schema", table.schema);
    const seen = new Set<string>();
    for (const column of config.columns) {
      if (typeof column !== "string") {
        throw new PgExtrasError("partitionedTable(): columns of a { name, schema } table must be database column name strings");
      }
      assertIdentifier("partition column", column);
      if (seen.has(column)) throw new PgExtrasError(`partitionedTable(${table.name}): duplicate partition column "${column}"`);
      seen.add(column);
    }
  }
  return brand(
    {
      table,
      method: config.method,
      columns: [...config.columns],
    },
    "partitionedTable",
  );
}

type PartitionInput = {
  parent: PartitionParent;
  schema?: string;
  onRemove?: "drop" | "detach";
  from?: readonly PartitionBound[];
  to?: readonly PartitionBound[];
  in?: readonly (PartitionBound | readonly PartitionBound[])[];
  modulus?: number;
  remainder?: number;
  default?: boolean;
};

/**
 * A child table created with `CREATE TABLE ... PARTITION OF`.
 * `onRemove` defaults to `"drop"`: removing the declaration drops the child when it is empty.
 */
export function pgPartition(
  name: string,
  config: { parent: PartitionParent; schema?: string; onRemove?: "drop" | "detach"; from: readonly PartitionBound[]; to: readonly PartitionBound[] },
): PgPartition;
export function pgPartition(
  name: string,
  config: {
    parent: PartitionParent;
    schema?: string;
    onRemove?: "drop" | "detach";
    in: readonly (PartitionBound | readonly PartitionBound[])[];
  },
): PgPartition;
export function pgPartition(
  name: string,
  config: { parent: PartitionParent; schema?: string; onRemove?: "drop" | "detach"; modulus: number; remainder: number },
): PgPartition;
export function pgPartition(
  name: string,
  config: { parent: PartitionParent; schema?: string; onRemove?: "drop" | "detach"; default: true },
): PgPartition;
export function pgPartition(name: string, config: PartitionInput): PgPartition {
  assertIdentifier("partition", name);
  if (config.schema) assertIdentifier("partition schema", config.schema);
  const onRemove = config.onRemove ?? "drop";
  if (onRemove !== "drop" && onRemove !== "detach") {
    throw new PgExtrasError(`pgPartition("${name}"): onRemove must be "drop" or "detach"`);
  }
  return brand(
    {
      name,
      schema: config.schema ?? null,
      parent: requireParent(config.parent, `pgPartition("${name}")`),
      mode: "create",
      onRemove,
      bound: readBound(`pgPartition("${name}")`, config),
    },
    "partition",
  );
}

/**
 * Attach a table drizzle-kit already created. Removing the declaration detaches it and leaves the table in place.
 * The table has to match the parent (column order, NOT NULL, unique indexes, and check constraints) or Postgres rejects ATTACH.
 */
export function pgAttachPartition(
  table: PgTable,
  config: { parent: PartitionParent; from: readonly PartitionBound[]; to: readonly PartitionBound[] },
): PgPartition;
export function pgAttachPartition(
  table: PgTable,
  config: { parent: PartitionParent; in: readonly (PartitionBound | readonly PartitionBound[])[] },
): PgPartition;
export function pgAttachPartition(
  table: PgTable,
  config: { parent: PartitionParent; modulus: number; remainder: number },
): PgPartition;
export function pgAttachPartition(table: PgTable, config: { parent: PartitionParent; default: true }): PgPartition;
export function pgAttachPartition(
  table: { name: string; schema?: string },
  config: { parent: PartitionParent; from: readonly PartitionBound[]; to: readonly PartitionBound[] },
): PgPartition;
export function pgAttachPartition(
  table: { name: string; schema?: string },
  config: { parent: PartitionParent; in: readonly (PartitionBound | readonly PartitionBound[])[] },
): PgPartition;
export function pgAttachPartition(
  table: { name: string; schema?: string },
  config: { parent: PartitionParent; modulus: number; remainder: number },
): PgPartition;
export function pgAttachPartition(
  table: { name: string; schema?: string },
  config: { parent: PartitionParent; default: true },
): PgPartition;
export function pgAttachPartition(
  table: PgTable | { name: string; schema?: string },
  config: PartitionInput,
): PgPartition {
  const identity = tableIdentity(table);
  return brand(
    {
      name: identity.name,
      schema: identity.schema,
      parent: requireParent(config.parent, `pgAttachPartition(${identity.name})`),
      mode: "attach",
      onRemove: "detach",
      bound: readBound(`pgAttachPartition(${identity.name})`, config),
    },
    "partition",
  );
}

/** Keep `table` detached from `parent`. Idempotent when it is not attached. */
export function pgDetachPartition(
  table: PgTable | { name: string; schema?: string },
  config: { parent: PartitionParent },
): PgDetach {
  const identity = tableIdentity(table);
  return brand(
    {
      table,
      parent: requireParent(config.parent, `pgDetachPartition(${identity.name})`),
    },
    "detach",
  );
}

function requireParent(parent: PartitionParent, where: string): PartitionParent {
  if (extrasKind(parent) === "partitionedTable") return parent;
  if (is(parent, PgTable) || isPlainTableRef(parent)) return parent;
  throw new PgExtrasError(`${where}: parent must be a Drizzle table, partitionedTable(), or { name, schema }`);
}

function isPlainTableRef(value: unknown): value is { name: string; schema?: string } {
  if (!isPlainRecord(value) || typeof value.name !== "string") return false;
  assertIdentifier("table", value.name);
  if (value.schema !== undefined) {
    if (typeof value.schema !== "string") return false;
    assertIdentifier("table schema", value.schema);
  }
  return true;
}

function readBound(label: string, config: PartitionInput): PartitionBoundSpec {
  const range = config.from !== undefined || config.to !== undefined;
  const list = config.in !== undefined;
  const hash = config.modulus !== undefined || config.remainder !== undefined;
  const isDefault = config.default === true;
  const selected = [range, list, hash, isDefault].filter(Boolean).length;
  if (config.default !== undefined && config.default !== true) {
    throw new PgExtrasError(`${label}: default must be true`);
  }
  if (selected !== 1) {
    throw new PgExtrasError(`${label}: pass from/to, in, modulus/remainder, or default, and only one of those`);
  }
  if (range) {
    if (!config.from || !config.to || config.from.length === 0 || config.to.length === 0) {
      throw new PgExtrasError(`${label}: range bounds need from and to`);
    }
    if (config.from.length !== config.to.length) {
      throw new PgExtrasError(`${label}: from and to must list one bound per partition column`);
    }
    return { kind: "range", from: [...config.from], to: [...config.to] };
  }
  if (list) {
    if (!config.in || config.in.length === 0) {
      throw new PgExtrasError(`${label}: in must list at least one value`);
    }
    return { kind: "list", values: config.in.map((value) => (Array.isArray(value) ? [...value] : value)) };
  }
  if (hash) {
    if (!Number.isInteger(config.modulus) || config.modulus! < 1) {
      throw new PgExtrasError(`${label}: modulus must be an integer >= 1`);
    }
    if (!Number.isInteger(config.remainder) || config.remainder! < 0 || config.remainder! >= config.modulus!) {
      throw new PgExtrasError(`${label}: remainder must be an integer from 0 to modulus - 1`);
    }
    return { kind: "hash", modulus: config.modulus!, remainder: config.remainder! };
  }
  return { kind: "default" };
}

function assertKeyCoveredByUniques(table: PgTable, keyColumns: readonly AnyPgColumn[]): void {
  const config = getTableConfig(table);
  const keyNames = keyColumns.map((column) => column.name);
  const groups: { label: string; names: string[] }[] = [];
  const singlePk = config.columns.filter((column) => column.primary).map((column) => column.name);
  if (singlePk.length > 0) groups.push({ label: "primary key", names: singlePk });
  for (const pk of config.primaryKeys) {
    groups.push({
      label: pk.name ? `primary key "${pk.name}"` : "primary key",
      names: pk.columns.map((column) => column.name),
    });
  }
  for (const unique of config.uniqueConstraints) {
    groups.push({
      label: unique.name ? `unique constraint "${unique.name}"` : "unique constraint",
      names: unique.columns.map((column) => column.name),
    });
  }
  for (const column of config.columns) {
    if (column.isUnique) groups.push({ label: `unique column "${column.name}"`, names: [column.name] });
  }
  for (const index of config.indexes) {
    if (!index.config.unique) continue;
    const names: string[] = [];
    for (const column of index.config.columns) {
      if (!is(column, Column)) {
        const indexName = index.config.name ? ` "${index.config.name}"` : "";
        throw new PgExtrasError(
          `partitionedTable(${config.name}): unique index${indexName} includes an expression. Postgres requires every unique index on a partitioned table to include the partition key.`,
        );
      }
      names.push(column.name);
    }
    groups.push({
      label: index.config.name ? `unique index "${index.config.name}"` : "unique index",
      names,
    });
  }
  for (const group of groups) {
    const missing = keyNames.filter((key) => !group.names.includes(key));
    if (missing.length === 0) continue;
    throw new PgExtrasError(
      `partitionedTable(${config.name}): ${group.label} (${group.names.join(", ")}) must include partition key ${missing.map((key) => `"${key}"`).join(", ")}. Postgres requires every primary key and unique constraint on a partitioned table to include the partition key.`,
    );
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

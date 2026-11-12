import {
  Column,
  ColumnBuilder,
  getTableColumns,
  is,
  sql,
  Table,
  type Casing,
  type ColumnBuilderBase,
  type SQL,
} from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";
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
  getMaterializedViewConfig,
  getTableConfig,
  getViewConfig,
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
import { assertIdentifier, quoteIdent } from "./quote.js";
import { renderSql } from "./render-sql.js";

const KIND = Symbol.for("drizzle-pg-extras.kind");
const COMMENT = Symbol.for("drizzle-pg-extras.comment");

export type ExtrasKind =
  | "function"
  | "trigger"
  | "extension"
  | "comment"
  | "partitionedTable"
  | "partition"
  | "detach"
  | "hypertable";

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

export type TriggerInitially = "immediate" | "deferred";

/** Options for `CREATE CONSTRAINT TRIGGER`. `true` means NOT DEFERRABLE. */
export type TriggerConstraint = {
  /** Default false: `NOT DEFERRABLE`. */
  deferrable?: boolean;
  /** Default `"immediate"`. `"deferred"` requires `deferrable: true`. */
  initially?: TriggerInitially;
  /** Referenced table in the `FROM` clause. */
  from?: PgTable | { name: string; schema?: string };
};

/** Statement transition tables: `REFERENCING OLD TABLE AS ... NEW TABLE AS ...`. */
export type TriggerReferencing = {
  oldTable?: string;
  newTable?: string;
};

export type TriggerRelation = PgTable | PgViewLike | { name: string; schema?: string };

export type PgTrigger = {
  readonly [KIND]: "trigger";
  readonly name: string | null;
  readonly table: TriggerRelation;
  readonly timing: TriggerTiming;
  readonly events: readonly TriggerEvent[];
  readonly forEach: TriggerForEach;
  readonly columns: readonly (AnyPgColumn | string)[];
  readonly when: WhenInput | null;
  readonly function: FunctionCall | null;
  readonly args: readonly TriggerArg[];
  readonly updatedAt: UpdatedAtSource | null;
  readonly constraint: boolean;
  readonly deferrable: boolean;
  readonly initially: TriggerInitially;
  readonly from: PgTable | { name: string; schema?: string } | null;
  readonly oldTable: string | null;
  readonly newTable: string | null;
  /** False emits `ALTER TABLE ... DISABLE TRIGGER` after the trigger exists. */
  readonly enabled: boolean;
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

export type HypertableOrderSpec = {
  column: AnyPgColumn | string;
  direction: "asc" | "desc" | null;
  nulls: "first" | "last" | null;
};

export type HypertableCompression = {
  segmentBy: readonly (AnyPgColumn | string)[];
  orderBy: readonly HypertableOrderSpec[];
};

export type HypertableRetention = {
  dropAfter: string;
  scheduleInterval: string | null;
};

export type HypertableCompressionPolicy = {
  compressAfter: string;
  scheduleInterval: string | null;
};

/**
 * A drizzle-kit table that `generate` turns into a TimescaleDB hypertable.
 * The table stays in the Drizzle schema. The migration calls `create_hypertable`.
 */
export type Hypertable = {
  readonly [KIND]: "hypertable";
  readonly table: PgTable | { name: string; schema?: string };
  readonly timeColumn: AnyPgColumn | string;
  readonly chunkTimeInterval: string | null;
  readonly partitioningColumn: AnyPgColumn | string | null;
  readonly numberPartitions: number | null;
  readonly migrateData: boolean;
  readonly compression: HypertableCompression | null;
  readonly retention: HypertableRetention | null;
  readonly compressionPolicy: HypertableCompressionPolicy | null;
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
  hypertables: Hypertable[];
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
    kind === "detach" ||
    kind === "hypertable"
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

type TriggerOptions = {
  constraint?: boolean | TriggerConstraint;
  referencing?: TriggerReferencing;
  /** Default true. `false` emits `ALTER TABLE ... DISABLE TRIGGER`. Views cannot be disabled. */
  enabled?: boolean;
};

type TableTriggerConfig<TTable extends PgTable> = TriggerOptions & {
  table: TTable;
  timing: "before" | "after";
  events: readonly TriggerEvent[];
  forEach?: TriggerForEach;
  columns?: readonly (TTable["_"]["columns"][keyof TTable["_"]["columns"]] | string)[];
  when?: string | SQL | ((refs: { NEW: RowRefs<TTable>; OLD: RowRefs<TTable> }) => SQL | string);
  function: FunctionCall;
  args?: readonly TriggerArg[];
};

type ViewColumn<TView> = Extract<TView[keyof TView], Column>;

type ViewTriggerConfig<TView extends PgViewLike> = TriggerOptions & {
  table: TView;
  timing: TriggerTiming;
  events: readonly TriggerEvent[];
  forEach?: TriggerForEach;
  columns?: readonly (ViewColumn<TView> | string)[];
  when?: string | SQL;
  function: FunctionCall;
  args?: readonly TriggerArg[];
};

type NameTriggerConfig = TriggerOptions & {
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
export function pgTrigger<TView extends PgViewLike>(name: string, config: ViewTriggerConfig<TView>): PgTrigger;
export function pgTrigger(name: string, config: NameTriggerConfig): PgTrigger;
export function pgTrigger(
  name: string,
  config: TableTriggerConfig<PgTable> | ViewTriggerConfig<PgViewLike> | NameTriggerConfig,
): PgTrigger {
  assertIdentifier("trigger", name);
  return finishTrigger(name, config.table, {
    timing: config.timing,
    events: config.events,
    forEach: config.forEach,
    columns: config.columns as readonly (AnyPgColumn | string)[] | undefined,
    when: (config.when ?? null) as WhenInput | null,
    function: config.function,
    args: config.args,
    constraint: config.constraint,
    referencing: config.referencing,
    enabled: config.enabled,
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
  table: TriggerRelation,
  config: {
    timing: TriggerTiming;
    events: readonly TriggerEvent[];
    forEach?: TriggerForEach;
    columns?: readonly (AnyPgColumn | string)[];
    when: WhenInput | null;
    function: FunctionCall | null;
    args?: readonly TriggerArg[];
    constraint?: boolean | TriggerConstraint;
    referencing?: TriggerReferencing;
    enabled?: boolean;
    updatedAt: UpdatedAtSource | null;
  },
): PgTrigger {
  const label = name ?? "updated-at trigger";
  if (!config.events || config.events.length === 0) {
    triggerError(label, "events must include at least one event");
  }
  const events = EVENT_ORDER.filter((event) => config.events.includes(event));
  if (events.length !== new Set(config.events).size) {
    triggerError(label, "unknown trigger event");
  }
  const forEach = config.forEach ?? "row";
  if (events.includes("truncate") && forEach === "row") {
    triggerError(label, 'truncate requires forEach: "statement"');
  }
  const identity = relationIdentity(table);
  if (identity.kind === "materializedView") {
    triggerError(label, "materialized views cannot have triggers");
  }
  const columns = config.columns ?? [];
  if (config.timing === "instead of") {
    if (identity.kind === "table") {
      triggerError(label, "INSTEAD OF triggers are only allowed on views. Pass a pgView() or { name, schema }");
    }
    if (forEach !== "row") {
      triggerError(label, "INSTEAD OF triggers must be FOR EACH ROW");
    }
    if (events.includes("truncate")) {
      triggerError(label, "INSTEAD OF triggers cannot include TRUNCATE");
    }
    if (columns.length > 0) {
      triggerError(label, "INSTEAD OF triggers cannot have column lists");
    }
  } else if (identity.kind === "view") {
    if (events.includes("truncate")) {
      triggerError(label, "views cannot have TRUNCATE triggers");
    }
    if (forEach === "row") {
      triggerError(
        label,
        'views cannot have row-level BEFORE or AFTER triggers. Use forEach: "statement", or INSTEAD OF FOR EACH ROW',
      );
    }
  }
  if (columns.length > 0 && !events.includes("update")) {
    triggerError(label, "columns only apply to the update event");
  }
  if (identity.kind === "table") {
    for (const column of columns) {
      if (typeof column !== "string") assertColumnOfTable(table as PgTable, column);
    }
  } else if (identity.kind === "view") {
    for (const column of columns) {
      if (typeof column === "string") continue;
      if (!viewOwnsColumn(table as PgViewLike, column, identity.name)) {
        throw new PgExtrasError(`column "${column.name}" does not belong to view "${identity.name}"`);
      }
    }
  } else {
    for (const column of columns) {
      if (typeof column !== "string") {
        triggerError(label, "columns on a { name, schema } table must be database column name strings");
      }
    }
  }
  const constraint = readConstraint(label, config.constraint, config.timing, forEach, identity.kind);
  const referencing = readReferencing(label, config.referencing, {
    timing: config.timing,
    events,
    columns: columns.length,
    kind: identity.kind,
    constraint: constraint !== null,
  });
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    triggerError(label, "enabled must be a boolean");
  }
  const enabled = config.enabled ?? true;
  if (!enabled && (identity.kind === "view" || config.timing === "instead of")) {
    triggerError(label, "Postgres cannot DISABLE TRIGGER on a view");
  }
  const when = config.when;
  const whenSql = renderWhenInput(label, table, when);
  if (whenSql) {
    assertWhenSql(label, whenSql, { timing: config.timing, events, forEach });
  }
  const fn = config.function;
  if (fn && extrasKind(fn) === "function") {
    const defined = fn as PgFunction;
    const returns = typeof defined.returns === "string" ? defined.returns.trim().toLowerCase() : defined.returns.getSQLType().toLowerCase();
    if (returns !== "trigger") {
      triggerError(label, `function "${defined.name}" returns ${returns}, not trigger`);
    }
    const argCount = config.args?.length ?? 0;
    if (defined.args.length !== argCount) {
      triggerError(
        label,
        `function "${defined.name}" has ${defined.args.length} argument(s), but the trigger passes ${argCount}`,
      );
    }
  } else if (!fn && !config.updatedAt) {
    triggerError(label, "function is required");
  }
  return brand(
    {
      name,
      table,
      timing: config.timing,
      events,
      forEach,
      columns,
      when,
      function: fn,
      args: config.args ?? [],
      updatedAt: config.updatedAt,
      constraint: constraint !== null,
      deferrable: constraint?.deferrable ?? false,
      initially: constraint?.initially ?? "immediate",
      from: constraint?.from ?? null,
      oldTable: referencing?.oldTable ?? null,
      newTable: referencing?.newTable ?? null,
      enabled,
    },
    "trigger",
  );
}

function triggerError(label: string, message: string): never {
  throw new PgExtrasError(`pgTrigger("${label}"): ${message}`);
}

type RelationKind = "table" | "view" | "materializedView" | "name";

export function relationIdentity(relation: TriggerRelation): { schema: string; name: string; kind: RelationKind } {
  if (is(relation, PgTable)) {
    const config = getTableConfig(relation);
    return { schema: schemaName(config.schema), name: config.name, kind: "table" };
  }
  if (isPgView(relation) || isPgMaterializedView(relation)) {
    const materialized = isPgMaterializedView(relation);
    const config = materialized ? getMaterializedViewConfig(relation) : getViewConfig(relation);
    return {
      schema: schemaName(config.schema),
      name: config.name,
      kind: materialized ? "materializedView" : "view",
    };
  }
  assertIdentifier("table", relation.name);
  if (relation.schema) assertIdentifier("table schema", relation.schema);
  return { schema: schemaName(relation.schema), name: relation.name, kind: "name" };
}

function viewOwnsColumn(view: PgViewLike, column: AnyPgColumn, viewName: string): boolean {
  const entries = relationColumnEntries(view);
  if (entries.some(([, owned]) => owned === column)) return true;
  // pgView() column access returns a fresh alias of the view's column, not the selectedFields object.
  const parent = column.table;
  if (!is(parent, PgTable) || getTableConfig(parent).name !== viewName) return false;
  return entries.some(([, owned]) => owned.name === column.name);
}

export function relationColumnEntries(relation: PgTable | PgViewLike): [string, AnyPgColumn][] {
  if (is(relation, PgTable)) return Object.entries(getTableColumns(relation));
  const config = isPgMaterializedView(relation) ? getMaterializedViewConfig(relation) : getViewConfig(relation);
  const entries: [string, AnyPgColumn][] = [];
  for (const [key, field] of Object.entries(config.selectedFields ?? {})) {
    if (is(field, Column)) entries.push([key, field as AnyPgColumn]);
  }
  return entries;
}

function schemaName(schema: string | undefined): string {
  return schema && schema.length > 0 ? schema : "public";
}

function readConstraint(
  label: string,
  constraint: boolean | TriggerConstraint | undefined,
  timing: TriggerTiming,
  forEach: TriggerForEach,
  kind: RelationKind,
): { deferrable: boolean; initially: TriggerInitially; from: PgTable | { name: string; schema?: string } | null } | null {
  if (constraint === undefined || constraint === false) return null;
  const value: TriggerConstraint = constraint === true ? {} : constraint;
  if (typeof value !== "object" || value === null) {
    triggerError(label, "constraint must be true or { deferrable, initially, from }");
  }
  const deferrable = value.deferrable ?? false;
  const initially = value.initially ?? "immediate";
  if (typeof deferrable !== "boolean") triggerError(label, "deferrable must be a boolean");
  if (initially !== "immediate" && initially !== "deferred") {
    triggerError(label, 'initially must be "immediate" or "deferred"');
  }
  if (initially === "deferred" && !deferrable) {
    triggerError(label, "INITIALLY DEFERRED requires DEFERRABLE");
  }
  if (timing !== "after" || forEach !== "row" || (kind !== "table" && kind !== "name")) {
    triggerError(label, "constraint triggers must be AFTER ... FOR EACH ROW on a table");
  }
  return { deferrable, initially, from: readReferencedTable(label, value.from) };
}

function readReferencedTable(
  label: string,
  from: TriggerConstraint["from"],
): PgTable | { name: string; schema?: string } | null {
  if (from === undefined) return null;
  if (isPgView(from) || isPgMaterializedView(from)) {
    triggerError(label, "FROM must reference a table");
  }
  if (is(from, PgTable)) return from;
  if (typeof from === "object" && from !== null && "name" in from && typeof from.name === "string") {
    assertIdentifier("referenced table", from.name);
    if (from.schema !== undefined) {
      if (typeof from.schema !== "string") triggerError(label, "FROM must reference a table");
      assertIdentifier("referenced table schema", from.schema);
    }
    return { name: from.name, schema: from.schema };
  }
  triggerError(label, "FROM must reference a table");
}

function readReferencing(
  label: string,
  referencing: TriggerReferencing | undefined,
  info: {
    timing: TriggerTiming;
    events: readonly TriggerEvent[];
    columns: number;
    kind: RelationKind;
    constraint: boolean;
  },
): { oldTable: string | null; newTable: string | null } | null {
  if (!referencing) return null;
  const oldTable = referencing.oldTable || undefined;
  const newTable = referencing.newTable || undefined;
  if (!oldTable && !newTable) {
    triggerError(label, "referencing needs oldTable or newTable");
  }
  if (oldTable) assertIdentifier("transition table", oldTable);
  if (newTable) assertIdentifier("transition table", newTable);
  if (oldTable && newTable && oldTable === newTable) {
    triggerError(label, "OLD TABLE and NEW TABLE must have different names");
  }
  if (info.constraint) triggerError(label, "constraint triggers cannot use transition tables");
  if (info.timing !== "after") triggerError(label, "transition tables are only allowed on AFTER triggers");
  if (info.kind === "view" || info.kind === "materializedView") {
    triggerError(label, "transition tables are only allowed on tables");
  }
  if (info.events.includes("truncate")) triggerError(label, "TRUNCATE triggers cannot use transition tables");
  if (info.events.length !== 1) {
    triggerError(label, "transition tables cannot be specified for triggers with more than one event");
  }
  if (info.columns > 0) triggerError(label, "transition tables cannot be combined with UPDATE OF");
  const event = info.events[0];
  if (oldTable && event !== "update" && event !== "delete") {
    triggerError(label, "OLD TABLE is only allowed for UPDATE or DELETE");
  }
  if (newTable && event !== "update" && event !== "insert") {
    triggerError(label, "NEW TABLE is only allowed for INSERT or UPDATE");
  }
  return { oldTable: oldTable ?? null, newTable: newTable ?? null };
}

/** Render a WHEN clause. Empty input becomes null. Throws when Postgres would reject the clause. */
export function renderTriggerWhen(trigger: PgTrigger, casing?: Casing): string | null {
  const label = trigger.name ?? "updated-at trigger";
  const text = renderWhenInput(label, trigger.table, trigger.when, casing);
  if (!text) return null;
  assertWhenSql(label, text, { timing: trigger.timing, events: trigger.events, forEach: trigger.forEach });
  return text;
}

function renderWhenInput(label: string, table: TriggerRelation, when: WhenInput | null, casing?: Casing): string | null {
  if (!when) return null;
  let value: SQL | string;
  if (typeof when === "function") {
    if (!is(table, PgTable) && !isPgView(table) && !isPgMaterializedView(table)) {
      triggerError(label, "WHEN callback needs a Drizzle table or view so NEW and OLD can be typed");
    }
    const entries = relationColumnEntries(table);
    value = when({
      NEW: rowProxy(entries, "NEW", casing),
      OLD: rowProxy(entries, "OLD", casing),
    });
  } else {
    value = when;
  }
  const text = (typeof value === "string" ? value : renderSql(value, casing)).trim().replace(/;+\s*$/, "");
  return text.length === 0 ? null : text;
}

function rowProxy(columns: readonly [string, AnyPgColumn][], alias: "NEW" | "OLD", casing: Casing | undefined): Record<string, SQL> {
  const cache = new CasingCache(casing);
  const refs: Record<string, SQL> = {};
  for (const [key, column] of columns) {
    refs[key] = sql.raw(`${alias}.${quoteIdent(cache.getColumnCasing(column))}`);
  }
  return refs;
}

function assertWhenSql(
  label: string,
  whenSql: string,
  info: { timing: TriggerTiming; events: readonly TriggerEvent[]; forEach: TriggerForEach },
): void {
  if (whenSql.includes(";")) triggerError(label, 'WHEN clause cannot contain ";"');
  if (info.timing === "instead of") triggerError(label, "INSTEAD OF triggers do not support WHEN");
  const refs = whenReferences(whenSql);
  if (refs.subquery) triggerError(label, "WHEN condition cannot contain a subquery");
  if (info.forEach === "statement" && (refs.old || refs.new)) {
    triggerError(label, "statement trigger WHEN cannot reference OLD or NEW");
  }
  if (info.events.includes("insert") && refs.old) triggerError(label, "INSERT trigger WHEN cannot reference OLD");
  if (info.events.includes("delete") && refs.new) triggerError(label, "DELETE trigger WHEN cannot reference NEW");
}

function whenReferences(whenSql: string): { old: boolean; new: boolean; subquery: boolean } {
  const stripped = stripSqlNoise(whenSql);
  return {
    old: /\bOLD\b/i.test(stripped),
    new: /\bNEW\b/i.test(stripped),
    subquery: /\b(?:SELECT|EXISTS)\b/i.test(stripped),
  };
}

function stripSqlNoise(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (ch === "-" && next === "-") {
      out += " ";
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      out += " ";
      const end = input.indexOf("*/", i + 2);
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (ch === "'") {
      out += " ";
      i++;
      while (i < input.length) {
        if (input[i] === "'" && input[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (input[i] === "'") break;
        i++;
      }
      continue;
    }
    if (ch === '"') {
      out += " ";
      i++;
      while (i < input.length) {
        if (input[i] === '"' && input[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (input[i] === '"') break;
        i++;
      }
      continue;
    }
    if (ch === "$") {
      const match = /^\$([A-Za-z0-9_]*)\$/.exec(input.slice(i));
      if (match) {
        const tag = match[0];
        const end = input.indexOf(tag, i + tag.length);
        out += " ";
        i = end === -1 ? input.length : end + tag.length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
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

function assertKeyCoveredByUniques(
  table: PgTable,
  keyColumns: readonly AnyPgColumn[],
  options?: { where?: string; noun?: string; requirement?: string; expressionRequirement?: string },
): void {
  const config = getTableConfig(table);
  const where = options?.where ?? `partitionedTable(${config.name})`;
  const noun = options?.noun ?? "partition key";
  const requirement =
    options?.requirement ??
    "Postgres requires every primary key and unique constraint on a partitioned table to include the partition key.";
  const expressionRequirement =
    options?.expressionRequirement ??
    "Postgres requires every unique index on a partitioned table to include the partition key.";
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
        throw new PgExtrasError(`${where}: unique index${indexName} includes an expression. ${expressionRequirement}`);
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
      `${where}: ${group.label} (${group.names.join(", ")}) must include ${noun} ${missing.map((key) => `"${key}"`).join(", ")}. ${requirement}`,
    );
  }
}

const INTERVAL_PART = String.raw`\d+(?:\.\d+)?\s+(?:microseconds?|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)`;
const INTERVAL_PATTERN = new RegExp(`^${INTERVAL_PART}(?:\\s+${INTERVAL_PART})*$`, "i");

type HypertableOrderInput =
  | AnyPgColumn
  | string
  | { column: AnyPgColumn | string; direction?: "asc" | "desc"; nulls?: "first" | "last" };

type DrizzleHypertableConfig<TTable extends PgTable> = {
  timeColumn: TTable["_"]["columns"][keyof TTable["_"]["columns"]];
  chunkTimeInterval?: string;
  partitioningColumn?: TTable["_"]["columns"][keyof TTable["_"]["columns"]];
  numberPartitions?: number;
  migrateData?: boolean;
  compression?: {
    segmentBy?: readonly TTable["_"]["columns"][keyof TTable["_"]["columns"]][];
    orderBy?: readonly (
      | TTable["_"]["columns"][keyof TTable["_"]["columns"]]
      | {
          column: TTable["_"]["columns"][keyof TTable["_"]["columns"]];
          direction?: "asc" | "desc";
          nulls?: "first" | "last";
        }
    )[];
  };
  retention?: { dropAfter: string; scheduleInterval?: string };
  compressionPolicy?: { compressAfter: string; scheduleInterval?: string };
};

type NameHypertableConfig = {
  timeColumn: string;
  chunkTimeInterval?: string;
  partitioningColumn?: string;
  numberPartitions?: number;
  migrateData?: boolean;
  compression?: {
    segmentBy?: readonly string[];
    orderBy?: readonly (string | { column: string; direction?: "asc" | "desc"; nulls?: "first" | "last" })[];
  };
  retention?: { dropAfter: string; scheduleInterval?: string };
  compressionPolicy?: { compressAfter: string; scheduleInterval?: string };
};

/**
 * Turn the empty table drizzle-kit created into a TimescaleDB hypertable.
 *
 * There is no `ALTER TABLE` that does this, and this package does not rewrite the
 * `CREATE TABLE` drizzle-kit already wrote. `generate` appends `create_hypertable`
 * with `if_not_exists => TRUE`. Export `pgExtension("timescaledb")` from the schema too.
 */
export function hypertable<TTable extends PgTable>(table: TTable, config: DrizzleHypertableConfig<TTable>): Hypertable;
export function hypertable(table: { name: string; schema?: string }, config: NameHypertableConfig): Hypertable;
export function hypertable(
  table: PgTable | { name: string; schema?: string },
  config: DrizzleHypertableConfig<PgTable> | NameHypertableConfig,
): Hypertable {
  const identity = tableIdentity(table);
  const where = `hypertable(${identity.schema}.${identity.name})`;
  const drizzleTable = is(table, PgTable) ? table : null;
  const timeColumn = resolveHypertableColumn(drizzleTable, config.timeColumn, `${where} timeColumn`);
  if (drizzleTable && typeof timeColumn !== "string") {
    if (!isHypertableTimeType(timeColumn.getSQLType())) {
      throw new PgExtrasError(
        `${where}: time column "${timeColumn.name}" is ${timeColumn.getSQLType()}. Use date, timestamp, or timestamptz. Integer time columns are not supported.`,
      );
    }
    if (!columnIsNotNull(drizzleTable, timeColumn)) {
      throw new PgExtrasError(
        `${where}: time column "${timeColumn.name}" must be NOT NULL. Call .notNull(), or include it in the primary key.`,
      );
    }
  }
  const partitioningColumn =
    config.partitioningColumn === undefined
      ? null
      : resolveHypertableColumn(drizzleTable, config.partitioningColumn, `${where} partitioningColumn`);
  const hasCount = config.numberPartitions !== undefined;
  if ((partitioningColumn === null) !== !hasCount) {
    throw new PgExtrasError(`${where}: set partitioningColumn and numberPartitions together`);
  }
  const numberPartitions = hasCount ? requirePartitionCount(config.numberPartitions, where) : null;
  if (partitioningColumn !== null && columnKey(timeColumn) === columnKey(partitioningColumn)) {
    throw new PgExtrasError(`${where}: partitioningColumn must be a different column from timeColumn`);
  }
  if (config.migrateData !== undefined && typeof config.migrateData !== "boolean") {
    throw new PgExtrasError(`${where}: migrateData must be a boolean`);
  }
  if (config.compressionPolicy && !config.compression) {
    throw new PgExtrasError(`${where}: compressionPolicy requires compression. Pass compression: {} or set segmentBy and orderBy.`);
  }
  const keyColumns = [timeColumn, ...(partitioningColumn ? [partitioningColumn] : [])].filter(
    (column): column is AnyPgColumn => typeof column !== "string",
  );
  if (drizzleTable && keyColumns.length > 0) {
    assertKeyCoveredByUniques(drizzleTable, keyColumns, {
      where,
      noun: "hypertable key",
      requirement:
        "Timescale requires every primary key and unique index on a hypertable to include the time column and the space-partitioning column.",
      expressionRequirement:
        "Timescale requires every unique index on a hypertable to include the time column and the space-partitioning column.",
    });
  }
  return brand(
    {
      table,
      timeColumn,
      chunkTimeInterval:
        config.chunkTimeInterval === undefined ? null : normalizeInterval(config.chunkTimeInterval, `${where} chunkTimeInterval`),
      partitioningColumn,
      numberPartitions,
      migrateData: config.migrateData ?? false,
      compression: config.compression ? readCompression(drizzleTable, config.compression, where) : null,
      retention: config.retention ? readRetention(config.retention, where) : null,
      compressionPolicy: config.compressionPolicy ? readCompressionPolicy(config.compressionPolicy, where) : null,
    },
    "hypertable",
  );
}

function readCompression(
  table: PgTable | null,
  compression: { segmentBy?: readonly (AnyPgColumn | string)[]; orderBy?: readonly HypertableOrderInput[] },
  where: string,
): HypertableCompression {
  const segmentBy = (compression.segmentBy ?? []).map((column, index) =>
    resolveHypertableColumn(table, column, `${where} compression.segmentBy[${index}]`),
  );
  const orderBy = (compression.orderBy ?? []).map((entry, index) => readOrder(table, entry, `${where} compression.orderBy[${index}]`));
  assertDistinctColumns(segmentBy, `${where} compression.segmentBy`);
  assertDistinctColumns(
    orderBy.map((entry) => entry.column),
    `${where} compression.orderBy`,
  );
  return { segmentBy, orderBy };
}

function readOrder(table: PgTable | null, entry: HypertableOrderInput, where: string): HypertableOrderSpec {
  if (typeof entry === "string" || is(entry, Column)) {
    return { column: resolveHypertableColumn(table, entry, where), direction: null, nulls: null };
  }
  if (!entry || typeof entry !== "object" || !("column" in entry)) {
    throw new PgExtrasError(`${where} must be a column or { column, direction, nulls }`);
  }
  const direction = entry.direction ?? null;
  const nulls = entry.nulls ?? null;
  if (direction !== null && direction !== "asc" && direction !== "desc") {
    throw new PgExtrasError(`${where}: direction must be "asc" or "desc"`);
  }
  if (nulls !== null && nulls !== "first" && nulls !== "last") {
    throw new PgExtrasError(`${where}: nulls must be "first" or "last"`);
  }
  return { column: resolveHypertableColumn(table, entry.column, where), direction, nulls };
}

function readRetention(retention: { dropAfter: string; scheduleInterval?: string }, where: string): HypertableRetention {
  if (retention.dropAfter === undefined) {
    throw new PgExtrasError(`${where} retention requires dropAfter, such as "6 months"`);
  }
  return {
    dropAfter: normalizeInterval(retention.dropAfter, `${where} retention.dropAfter`),
    scheduleInterval:
      retention.scheduleInterval === undefined ? null : normalizeInterval(retention.scheduleInterval, `${where} retention.scheduleInterval`),
  };
}

function readCompressionPolicy(
  policy: { compressAfter: string; scheduleInterval?: string },
  where: string,
): HypertableCompressionPolicy {
  if (policy.compressAfter === undefined) {
    throw new PgExtrasError(`${where} compressionPolicy requires compressAfter, such as "7 days"`);
  }
  return {
    compressAfter: normalizeInterval(policy.compressAfter, `${where} compressionPolicy.compressAfter`),
    scheduleInterval:
      policy.scheduleInterval === undefined
        ? null
        : normalizeInterval(policy.scheduleInterval, `${where} compressionPolicy.scheduleInterval`),
  };
}

function resolveHypertableColumn(table: PgTable | null, column: AnyPgColumn | string, where: string): AnyPgColumn | string {
  if (table) {
    if (typeof column === "string") {
      throw new PgExtrasError(`${where}: pass a column from the Drizzle table, not a name string`);
    }
    assertColumnOfTable(table, column);
    return column;
  }
  if (typeof column !== "string") {
    throw new PgExtrasError(`${where}: pass a database column name string`);
  }
  assertIdentifier("column", column);
  return column;
}

function columnKey(column: AnyPgColumn | string): string {
  return typeof column === "string" ? column : column.name;
}

function assertDistinctColumns(columns: readonly (AnyPgColumn | string)[], where: string): void {
  const seen = new Set<string>();
  for (const column of columns) {
    const key = columnKey(column);
    if (seen.has(key)) throw new PgExtrasError(`${where}: duplicate column "${key}"`);
    seen.add(key);
  }
}

function columnIsNotNull(table: PgTable, column: AnyPgColumn): boolean {
  if (column.notNull || column.primary) return true;
  return getTableConfig(table).primaryKeys.some((constraint) => constraint.columns.includes(column));
}

function isHypertableTimeType(sqlType: string): boolean {
  const type = sqlType.trim().toLowerCase();
  return type === "date" || type.startsWith("timestamp");
}

function requirePartitionCount(value: number | undefined, where: string): number {
  if (!Number.isInteger(value) || value! < 1) {
    throw new PgExtrasError(`${where}: numberPartitions must be an integer >= 1`);
  }
  return value!;
}

function normalizeInterval(value: string, where: string): string {
  if (typeof value !== "string") {
    throw new PgExtrasError(`${where} must be an interval such as "1 day" or "7 days"`);
  }
  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!INTERVAL_PATTERN.test(normalized)) {
    throw new PgExtrasError(`${where} must be an interval such as "1 day" or "7 days", with no SQL punctuation`);
  }
  for (const part of normalized.match(new RegExp(INTERVAL_PART, "gi")) ?? []) {
    const quantity = Number(part.split(/\s+/)[0]);
    if (!(quantity > 0)) throw new PgExtrasError(`${where} must be greater than 0`);
  }
  return normalized;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

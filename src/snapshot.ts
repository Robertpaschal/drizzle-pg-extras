import { Column, SQL, getTableColumns, is, type Casing } from "drizzle-orm";
import { CasingCache, toCamelCase, toSnakeCase } from "drizzle-orm/casing";
import {
  CheckBuilder,
  ForeignKeyBuilder,
  IndexBuilder,
  PgArray,
  PgEnumColumn,
  PgEnumObjectColumn,
  PgTable,
  PrimaryKeyBuilder,
  UniqueConstraintBuilder,
  getMaterializedViewConfig,
  getViewConfig,
  isPgEnum,
  isPgMaterializedView,
  isPgView,
  type AnyPgColumn,
  type ForeignKey,
  type Index,
  type PgView,
  type PrimaryKey,
  type UniqueConstraint,
} from "drizzle-orm/pg-core";
import {
  assertColumnOfTable,
  extrasKind,
  readComment,
  relationIdentity,
  renderTriggerWhen,
  tableIdentity,
  type AnyPgEnum,
  type PgViewLike,
  type PartitionBound,
  type PartitionedTable,
  type PgComment,
  type PgDetach,
  type PgExtras,
  type PgFunction,
  type PgPartition,
  type PgTrigger,
  type TriggerArg,
  type TriggerInitially,
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
  constraint: boolean;
  deferrable: boolean;
  initially: TriggerInitially;
  fromSchema: string | null;
  fromTable: string | null;
  oldTable: string | null;
  newTable: string | null;
  enabled: boolean;
};

export type ExtensionSnapshot = {
  id: string;
  name: string;
  schema: string | null;
  version: string | null;
  cascade: boolean;
};

export type CommentKind =
  | "table"
  | "column"
  | "enum"
  | "view"
  | "materializedView"
  | "function"
  | "trigger"
  | "index"
  | "constraint"
  | "extension";

export type CommentSnapshot = {
  id: string;
  kind: CommentKind;
  schema: string;
  /** Table, column, enum, view, function, trigger, index, constraint, or extension name. */
  name: string;
  /** Table or view that owns a column, trigger, or constraint. */
  relation: string | null;
  column: string | null;
  argTypes: string[];
  text: string;
};

export type InventoryTable = {
  schema: string;
  name: string;
  columns: string[];
};

export type InventoryName = {
  schema: string;
  name: string;
};

export type InventoryView = {
  schema: string;
  name: string;
  materialized: boolean;
  columns: string[];
};

export type InventoryIndex = {
  schema: string;
  table: string;
  name: string;
};

export type InventoryConstraint = {
  schema: string;
  table: string;
  name: string;
};

export type PartitionedTableSnapshot = {
  id: string;
  schema: string;
  name: string;
  method: "range" | "list" | "hash";
  columns: string[];
};

export type PartitionSnapshot = {
  id: string;
  schema: string;
  name: string;
  parentSchema: string;
  parentName: string;
  mode: "create" | "attach";
  onRemove: "drop" | "detach";
  boundKind: "range" | "list" | "hash" | "default";
  /** `DEFAULT` or a `FOR VALUES ...` clause, with literals already quoted. */
  boundSql: string;
};

export type DetachSnapshot = {
  id: string;
  schema: string;
  name: string;
  parentSchema: string;
  parentName: string;
};

export type Snapshot = {
  version: 1;
  functions: FunctionSnapshot[];
  triggers: TriggerSnapshot[];
  extensions: ExtensionSnapshot[];
  comments: CommentSnapshot[];
  partitionedTables: PartitionedTableSnapshot[];
  partitions: PartitionSnapshot[];
  detaches: DetachSnapshot[];
  inventory: {
    scanned: boolean;
    tables: InventoryTable[];
    enums: InventoryName[];
    views: InventoryView[];
    indexes: InventoryIndex[];
    constraints: InventoryConstraint[];
  };
};

export function emptySnapshot(): Snapshot {
  return {
    version: 1,
    functions: [],
    triggers: [],
    extensions: [],
    comments: [],
    partitionedTables: [],
    partitions: [],
    detaches: [],
    inventory: { scanned: false, tables: [], enums: [], views: [], indexes: [], constraints: [] },
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
  const triggerByObject = new Map<PgTrigger, TriggerSnapshot>();
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
    const snap = snapshotTrigger(trigger, casing, nameOf, fnByObject, owned);
    triggers.push(snap);
    triggerByObject.set(trigger, snap);
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
  const inventoryIndexes: InventoryIndex[] = [];
  const inventoryConstraints: InventoryConstraint[] = [];
  for (const table of extras.tables) {
    const harvested = harvest(table, nameOf);
    if (harvested.table) pushComment(comments, harvested.table);
    for (const column of harvested.columns) pushComment(comments, column);
    const relations = harvestRelations(table, nameOf, casing);
    for (const comment of relations.comments) pushComment(comments, comment);
    inventoryIndexes.push(...relations.indexes);
    inventoryConstraints.push(...relations.constraints);
  }
  for (const fn of extras.functions) {
    const text = readComment(fn);
    const snap = fnByObject.get(fn);
    if (text && snap) pushComment(comments, functionComment(snap, text));
  }
  for (const trigger of extras.triggers) {
    const text = readComment(trigger);
    const snap = triggerByObject.get(trigger);
    if (text && snap) pushComment(comments, triggerComment(snap, text));
  }
  for (const ext of extras.extensions) {
    const text = readComment(ext);
    if (text) pushComment(comments, extensionComment(ext.name, text));
  }
  const enumObjects = enumObjectsIn(extras);
  for (const enumObject of enumObjects) {
    const text = readComment(enumObject as object);
    if (!text) continue;
    pushComment(comments, enumComment(enumIdentity(enumObject), text));
  }
  for (const view of extras.views) {
    for (const comment of harvestView(view, nameOf)) pushComment(comments, comment);
  }
  for (const comment of extras.comments) {
    pushComment(comments, snapshotComment(comment, nameOf, casing, fnByObject, triggerByObject, extras));
  }

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
  const inventoryEnums = uniqueNames(enumObjects.map((enumObject) => enumIdentity(enumObject)));
  const inventoryViews = extras.views.map((view) => {
    const identity = viewIdentity(view);
    return {
      schema: identity.schema,
      name: identity.name,
      materialized: identity.materialized,
      columns: identity.columns.map((column) => nameOf(column)).sort(),
    };
  });
  inventoryViews.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
  inventoryIndexes.sort((a, b) => `${a.schema}.${a.table}.${a.name}`.localeCompare(`${b.schema}.${b.table}.${b.name}`));
  inventoryConstraints.sort((a, b) => `${a.schema}.${a.table}.${a.name}`.localeCompare(`${b.schema}.${b.table}.${b.name}`));

  const partitionedTables = snapshotPartitionedTables(extras, nameOf);
  const partitions = snapshotPartitions(extras, partitionedTables);
  const detaches = snapshotDetaches(extras, partitions);

  functions.sort((a, b) => a.id.localeCompare(b.id));
  triggers.sort((a, b) => a.id.localeCompare(b.id));
  extensions.sort((a, b) => a.id.localeCompare(b.id));
  comments.sort((a, b) => a.id.localeCompare(b.id));
  partitionedTables.sort((a, b) => a.id.localeCompare(b.id));
  partitions.sort((a, b) => a.id.localeCompare(b.id));
  detaches.sort((a, b) => a.id.localeCompare(b.id));

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
    partitionedTables,
    partitions,
    detaches,
    inventory: {
      scanned: true,
      tables: inventoryTables,
      enums: inventoryEnums,
      views: inventoryViews,
      indexes: inventoryIndexes,
      constraints: inventoryConstraints,
    },
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
    throw new PgExtrasError(`comment on ${commentLabel(snap)} is declared twice with different text`);
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
  const identity = relationIdentity(trigger.table);
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
  const when = renderTriggerWhen(trigger, casing);
  const from = trigger.from ? tableIdentity(trigger.from) : null;
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
    constraint: trigger.constraint,
    deferrable: trigger.deferrable,
    initially: trigger.initially,
    fromSchema: from?.schema ?? null,
    fromTable: from?.name ?? null,
    oldTable: trigger.oldTable,
    newTable: trigger.newTable,
    enabled: trigger.enabled,
  };
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
    columns.push(columnComment(identity.schema, identity.name, nameOf(column), text));
  }
  const tableText = readComment(table);
  return {
    table: tableText ? tableComment(identity.schema, identity.name, tableText) : null,
    columns,
  };
}

function snapshotComment(
  comment: PgComment,
  nameOf: (column: AnyPgColumn) => string,
  casing: Casing | undefined,
  fnByObject: Map<PgFunction, FunctionSnapshot>,
  triggerByObject: Map<PgTrigger, TriggerSnapshot>,
  extras: PgExtras,
): CommentSnapshot {
  const target = comment.target;
  if (is(target, PgTable)) {
    const identity = tableIdentity(target);
    return tableComment(identity.schema, identity.name, comment.text);
  }
  if (is(target, Column)) {
    return columnCommentFrom(target, comment.text, nameOf, extras);
  }
  if (isPgEnum(target)) {
    return enumComment(enumIdentity(target), comment.text);
  }
  if (isPgView(target) || isPgMaterializedView(target)) {
    const identity = viewIdentity(target);
    return viewComment(identity.schema, identity.name, identity.materialized, comment.text);
  }
  if (extrasKind(target) === "function") {
    const fn = target as PgFunction;
    const snap = fnByObject.get(fn) ?? snapshotFunction(fn, casing);
    return functionComment(snap, comment.text);
  }
  if (extrasKind(target) === "trigger") {
    const trigger = target as PgTrigger;
    const snap = triggerByObject.get(trigger) ?? snapshotTrigger(trigger, casing, nameOf, fnByObject, ownedUpdatedAt(trigger, nameOf));
    return triggerComment(snap, comment.text);
  }
  if (extrasKind(target) === "extension") {
    return extensionComment((target as PgExtras["extensions"][number]).name, comment.text);
  }
  throw new PgExtrasError("commentOn() takes a table, column, enum, view, function, trigger, or extension");
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
  return JSON.stringify(triggerShape(a, true)) === JSON.stringify(triggerShape(b, true));
}

/** Definition equality, ignoring the enabled flag. Enable and disable are `ALTER TABLE`. */
export function sameTriggerShape(a: TriggerSnapshot, b: TriggerSnapshot): boolean {
  return JSON.stringify(triggerShape(a, false)) === JSON.stringify(triggerShape(b, false));
}

function triggerShape(trigger: TriggerSnapshot, includeEnabled: boolean) {
  return {
    name: trigger.name,
    schema: trigger.schema,
    table: trigger.table,
    timing: trigger.timing,
    events: trigger.events,
    forEach: trigger.forEach,
    columns: trigger.columns,
    when: trigger.when,
    functionSchema: trigger.functionSchema,
    functionName: trigger.functionName,
    functionArgsSql: trigger.functionArgsSql,
    functionId: trigger.functionId,
    constraint: trigger.constraint,
    deferrable: trigger.deferrable,
    initially: trigger.initially,
    fromSchema: trigger.fromSchema,
    fromTable: trigger.fromTable,
    oldTable: trigger.oldTable,
    newTable: trigger.newTable,
    enabled: includeEnabled ? trigger.enabled : true,
  };
}

function normalizeTrigger(value: unknown): TriggerSnapshot {
  if (!value || typeof value !== "object") throw new PgExtrasError("pg extras snapshot trigger is not an object");
  const raw = value as Partial<TriggerSnapshot>;
  if (typeof raw.name !== "string" || typeof raw.schema !== "string") {
    throw new PgExtrasError("pg extras snapshot trigger is missing a name");
  }
  const timing = raw.timing === "before" || raw.timing === "after" || raw.timing === "instead of" ? raw.timing : "after";
  const forEach = raw.forEach === "statement" ? "statement" : "row";
  const initially = raw.initially === "deferred" ? "deferred" : "immediate";
  const events = Array.isArray(raw.events) ? raw.events.filter((event): event is TriggerSnapshot["events"][number] =>
    event === "insert" || event === "update" || event === "delete" || event === "truncate",
  ) : [];
  const table = typeof raw.table === "string" ? raw.table : "";
  return {
    id: typeof raw.id === "string" ? raw.id : JSON.stringify(["trigger", raw.schema, table, raw.name]),
    name: raw.name,
    schema: raw.schema,
    table,
    timing,
    events,
    forEach,
    columns: Array.isArray(raw.columns) ? raw.columns.filter((column): column is string => typeof column === "string") : [],
    when: typeof raw.when === "string" ? raw.when : null,
    functionSchema: typeof raw.functionSchema === "string" ? raw.functionSchema : "public",
    functionName: typeof raw.functionName === "string" ? raw.functionName : "",
    functionArgsSql: Array.isArray(raw.functionArgsSql)
      ? raw.functionArgsSql.filter((arg): arg is string => typeof arg === "string")
      : [],
    functionId: typeof raw.functionId === "string" ? raw.functionId : null,
    constraint: raw.constraint === true,
    deferrable: raw.deferrable === true,
    initially,
    fromSchema: typeof raw.fromSchema === "string" ? raw.fromSchema : null,
    fromTable: typeof raw.fromTable === "string" ? raw.fromTable : null,
    oldTable: typeof raw.oldTable === "string" ? raw.oldTable : null,
    newTable: typeof raw.newTable === "string" ? raw.newTable : null,
    enabled: raw.enabled === false ? false : true,
  };
}

export function parseSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== "object") throw new PgExtrasError("pg extras snapshot is not an object");
  const record = value as Partial<Snapshot> & { comments?: unknown; inventory?: unknown };
  if (record.version !== 1) throw new PgExtrasError(`pg extras snapshot version ${String(record.version)} is not supported`);
  const comments = Array.isArray(record.comments) ? record.comments.map((comment) => normalizeComment(comment)) : [];
  return {
    version: 1,
    functions: record.functions ?? [],
    triggers: Array.isArray(record.triggers) ? record.triggers.map((trigger) => normalizeTrigger(trigger)) : [],
    extensions: record.extensions ?? [],
    comments,
    partitionedTables: record.partitionedTables ?? [],
    partitions: record.partitions ?? [],
    detaches: record.detaches ?? [],
    inventory: normalizeInventory(record.inventory),
  };
}

const COMMENT_KINDS = new Set<CommentKind>([
  "table",
  "column",
  "enum",
  "view",
  "materializedView",
  "function",
  "trigger",
  "index",
  "constraint",
  "extension",
]);

function normalizeComment(value: unknown): CommentSnapshot {
  if (!value || typeof value !== "object") throw new PgExtrasError("pg extras snapshot comment is not an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !COMMENT_KINDS.has(raw.kind as CommentKind)) {
    throw new PgExtrasError(`pg extras snapshot has an unknown comment kind ${String(raw.kind)}`);
  }
  const kind = raw.kind as CommentKind;
  const schema = typeof raw.schema === "string" ? raw.schema : "public";
  const column = typeof raw.column === "string" ? raw.column : null;
  const legacyRelation = typeof raw.table === "string" ? raw.table : null;
  const relation = typeof raw.relation === "string" ? raw.relation : legacyRelation;
  const name =
    typeof raw.name === "string" ? raw.name : kind === "column" ? (column ?? "") : (legacyRelation ?? "");
  if (name.length === 0) throw new PgExtrasError("pg extras snapshot comment is missing a name");
  if (typeof raw.text !== "string") throw new PgExtrasError("pg extras snapshot comment is missing text");
  const argTypes = Array.isArray(raw.argTypes) ? raw.argTypes.filter((item): item is string => typeof item === "string") : [];
  const id = typeof raw.id === "string" ? raw.id : JSON.stringify([kind, schema, relation, name]);
  return { id, kind, schema, name, relation, column, argTypes, text: raw.text };
}

function normalizeInventory(value: unknown): Snapshot["inventory"] {
  const empty = emptySnapshot().inventory;
  if (!value || typeof value !== "object") return empty;
  const raw = value as Partial<Snapshot["inventory"]>;
  return {
    scanned: raw.scanned === true,
    tables: Array.isArray(raw.tables) ? raw.tables : [],
    enums: Array.isArray(raw.enums) ? raw.enums : [],
    views: Array.isArray(raw.views) ? raw.views : [],
    indexes: Array.isArray(raw.indexes) ? raw.indexes : [],
    constraints: Array.isArray(raw.constraints) ? raw.constraints : [],
  };
}

function tableComment(schema: string, table: string, text: string): CommentSnapshot {
  return {
    id: JSON.stringify(["table", schema, table, null]),
    kind: "table",
    schema,
    name: table,
    relation: table,
    column: null,
    argTypes: [],
    text,
  };
}

function columnComment(schema: string, relation: string, column: string, text: string): CommentSnapshot {
  return {
    id: JSON.stringify(["column", schema, relation, column]),
    kind: "column",
    schema,
    name: column,
    relation,
    column,
    argTypes: [],
    text,
  };
}

function enumComment(identity: { schema: string; name: string }, text: string): CommentSnapshot {
  return {
    id: JSON.stringify(["enum", identity.schema, identity.name]),
    kind: "enum",
    schema: identity.schema,
    name: identity.name,
    relation: null,
    column: null,
    argTypes: [],
    text,
  };
}

function viewComment(schema: string, name: string, materialized: boolean, text: string): CommentSnapshot {
  const kind = materialized ? "materializedView" : "view";
  return {
    id: JSON.stringify([kind, schema, name]),
    kind,
    schema,
    name,
    relation: null,
    column: null,
    argTypes: [],
    text,
  };
}

function functionComment(fn: FunctionSnapshot, text: string): CommentSnapshot {
  const argTypes = fn.args.map((arg) => arg.type);
  return {
    id: JSON.stringify(["function", fn.schema, fn.name, argTypes]),
    kind: "function",
    schema: fn.schema,
    name: fn.name,
    relation: null,
    column: null,
    argTypes,
    text,
  };
}

function triggerComment(trigger: TriggerSnapshot, text: string): CommentSnapshot {
  return {
    id: trigger.id,
    kind: "trigger",
    schema: trigger.schema,
    name: trigger.name,
    relation: trigger.table,
    column: null,
    argTypes: [],
    text,
  };
}

function extensionComment(name: string, text: string): CommentSnapshot {
  return {
    id: JSON.stringify(["extension", name]),
    kind: "extension",
    schema: "public",
    name,
    relation: null,
    column: null,
    argTypes: [],
    text,
  };
}

function indexComment(schema: string, name: string, text: string): CommentSnapshot {
  return {
    id: JSON.stringify(["index", schema, name]),
    kind: "index",
    schema,
    name,
    relation: null,
    column: null,
    argTypes: [],
    text,
  };
}

function constraintComment(schema: string, table: string, name: string, text: string): CommentSnapshot {
  return {
    id: JSON.stringify(["constraint", schema, table, name]),
    kind: "constraint",
    schema,
    name,
    relation: table,
    column: null,
    argTypes: [],
    text,
  };
}

function commentLabel(comment: CommentSnapshot): string {
  if (comment.kind === "column") return `${comment.schema}.${comment.relation}.${comment.column}`;
  if (comment.kind === "function") return `function ${comment.schema}.${comment.name}(${comment.argTypes.join(", ")})`;
  if (comment.kind === "trigger" || comment.kind === "constraint") {
    return `${comment.kind} ${comment.name} on ${comment.schema}.${comment.relation}`;
  }
  if (comment.kind === "extension") return `extension ${comment.name}`;
  return `${comment.kind} ${comment.schema}.${comment.name}`;
}

function columnCommentFrom(
  column: AnyPgColumn,
  text: string,
  nameOf: (column: AnyPgColumn) => string,
  extras: PgExtras,
): CommentSnapshot {
  if (!column.table || !is(column.table, PgTable)) {
    throw new PgExtrasError(`commentOn() column "${column.name}" is not attached to a Postgres table or view`);
  }
  const identity = tableIdentity(column.table);
  const dbName = nameOf(column);
  const knownTable = extras.tables.find((table) => {
    const id = tableIdentity(table);
    return id.schema === identity.schema && id.name === identity.name;
  });
  if (knownTable) {
    assertColumnOfTable(knownTable, column);
    return columnComment(identity.schema, identity.name, dbName, text);
  }
  const view = extras.views.find((item) => viewIdentity(item).name === identity.name);
  if (view) {
    const viewId = viewIdentity(view);
    return columnComment(viewId.schema, viewId.name, dbName, text);
  }
  assertColumnOfTable(column.table, column);
  return columnComment(identity.schema, identity.name, dbName, text);
}

const ExtraConfigBuilder = Symbol.for("drizzle:ExtraConfigBuilder");
const ExtraConfigColumns = Symbol.for("drizzle:ExtraConfigColumns");

function readExtraConfig(table: PgTable): unknown[] {
  const builder = (table as unknown as Record<symbol, unknown>)[ExtraConfigBuilder];
  if (typeof builder !== "function") return [];
  const columns = (table as unknown as Record<symbol, unknown>)[ExtraConfigColumns];
  const extra = (builder as (value: unknown) => unknown)(columns);
  if (!extra || typeof extra !== "object") return [];
  return Array.isArray(extra) ? extra.flat(1) : Object.values(extra);
}

function harvestRelations(
  table: PgTable,
  nameOf: (column: AnyPgColumn) => string,
  casing: Casing | undefined,
): { comments: CommentSnapshot[]; indexes: InventoryIndex[]; constraints: InventoryConstraint[] } {
  const identity = tableIdentity(table);
  const comments: CommentSnapshot[] = [];
  const indexes: InventoryIndex[] = [];
  const constraints: InventoryConstraint[] = [];
  for (const value of readExtraConfig(table)) {
    if (extrasKind(value) === "comment") {
      throw new PgExtrasError(
        "Return the index or constraint from the table extra config wrapped with withComment(). commentOn() is for tables, columns, enums, views, functions, triggers, and extensions.",
      );
    }
    if (is(value, IndexBuilder)) {
      const built = value.build(table);
      const text = readComment(value);
      let name: string;
      try {
        name = resolveIndexName(built, identity.name, casing);
      } catch (error) {
        if (text) throw error;
        continue;
      }
      indexes.push({ schema: identity.schema, table: identity.name, name });
      if (text) comments.push(indexComment(identity.schema, name, text));
      continue;
    }
    if (is(value, CheckBuilder)) {
      const name = value.name;
      constraints.push({ schema: identity.schema, table: identity.name, name });
      const text = readComment(value);
      if (text) comments.push(constraintComment(identity.schema, identity.name, name, text));
      continue;
    }
    if (is(value, UniqueConstraintBuilder)) {
      const built = buildOf<UniqueConstraint>(value, table);
      const name = constraintName(built);
      constraints.push({ schema: identity.schema, table: identity.name, name });
      const text = readComment(value);
      if (text) comments.push(constraintComment(identity.schema, identity.name, name, text));
      continue;
    }
    if (is(value, ForeignKeyBuilder)) {
      const built = buildOf<ForeignKey>(value, table);
      const name = applyCasing(built.getName(), [...built.reference().columns, ...built.reference().foreignColumns], nameOf, casing);
      constraints.push({ schema: identity.schema, table: identity.name, name });
      const text = readComment(value);
      if (text) comments.push(constraintComment(identity.schema, identity.name, name, text));
      continue;
    }
    if (is(value, PrimaryKeyBuilder)) {
      const built = buildOf<PrimaryKey>(value, table);
      const name = applyCasing(built.getName(), built.columns, nameOf, casing);
      constraints.push({ schema: identity.schema, table: identity.name, name });
      const text = readComment(value);
      if (text) comments.push(constraintComment(identity.schema, identity.name, name, text));
    }
  }
  return { comments, indexes, constraints };
}

function buildOf<T>(builder: object, table: PgTable): T {
  return (builder as { build(table: PgTable): T }).build(table);
}

function constraintName(constraint: { name?: string; getName(): string | undefined }): string {
  const name = constraint.name ?? constraint.getName();
  if (!name) throw new PgExtrasError("constraint comment needs a constraint name");
  return name;
}

function applyCasing(
  name: string,
  columns: readonly AnyPgColumn[],
  nameOf: (column: AnyPgColumn) => string,
  casing: Casing | undefined,
): string {
  if (!casing) return name;
  let result = name;
  for (const column of columns) {
    const cased = nameOf(column);
    if (column.name !== cased) result = result.replace(column.name, cased);
  }
  return result;
}

function resolveIndexName(index: Index, tableName: string, casing: Casing | undefined): string {
  if (index.config.name && index.config.name.length > 0) return index.config.name;
  const columns: string[] = [];
  for (const column of index.config.columns) {
    if (is(column, SQL)) {
      throw new PgExtrasError(
        `index comment on "${tableName}" needs an index name. Drizzle names indexes made of columns only; name an index whose key is a SQL expression.`,
      );
    }
    const indexed = column as { name?: string; keyAsName?: boolean };
    if (!indexed.name) {
      throw new PgExtrasError(`index comment on "${tableName}" needs an index name`);
    }
    columns.push(casedIndexColumn(indexed.name, Boolean(indexed.keyAsName), casing));
  }
  return `${tableName}_${columns.join("_")}_index`;
}

function casedIndexColumn(name: string, keyAsName: boolean, casing: Casing | undefined): string {
  if (!keyAsName || !casing) return name;
  return casing === "camelCase" ? toCamelCase(name) : toSnakeCase(name);
}

function harvestView(view: PgViewLike, nameOf: (column: AnyPgColumn) => string): CommentSnapshot[] {
  const identity = viewIdentity(view);
  const comments: CommentSnapshot[] = [];
  const text = readComment(view);
  if (text) comments.push(viewComment(identity.schema, identity.name, identity.materialized, text));
  for (const column of identity.columns) {
    const columnText = readComment(column);
    if (!columnText) continue;
    comments.push(columnComment(identity.schema, identity.name, nameOf(column), columnText));
  }
  return comments;
}

function viewIdentity(view: PgViewLike): { schema: string; name: string; materialized: boolean; columns: AnyPgColumn[] } {
  const materialized = isPgMaterializedView(view);
  const config = materialized ? getMaterializedViewConfig(view) : getViewConfig(view as PgView);
  const columns: AnyPgColumn[] = [];
  for (const field of Object.values(config.selectedFields ?? {})) {
    if (is(field, Column)) columns.push(field as AnyPgColumn);
  }
  return {
    schema: config.schema && config.schema.length > 0 ? config.schema : "public",
    name: config.name,
    materialized,
    columns,
  };
}

function enumObjectsIn(extras: PgExtras): AnyPgEnum[] {
  const found: AnyPgEnum[] = [];
  const add = (value: unknown) => {
    if (!isPgEnum(value) || found.includes(value as AnyPgEnum)) return;
    found.push(value as AnyPgEnum);
  };
  for (const enumObject of extras.enums) add(enumObject);
  for (const comment of extras.comments) add(comment.target);
  for (const table of extras.tables) {
    for (const column of Object.values(getTableColumns(table))) add(enumFromColumn(column));
  }
  for (const view of extras.views) {
    for (const column of viewIdentity(view).columns) add(enumFromColumn(column));
  }
  return found;
}

function enumFromColumn(column: AnyPgColumn): AnyPgEnum | null {
  let current: object = column;
  while (is(current, PgArray)) current = current.baseColumn;
  if (is(current, PgEnumColumn) || is(current, PgEnumObjectColumn)) return current.enum as AnyPgEnum;
  return null;
}

function enumIdentity(value: unknown): { schema: string; name: string } {
  const enumObject = value as { enumName?: string; schema?: string };
  if (!enumObject.enumName) throw new PgExtrasError("enum comment is missing an enum name");
  return {
    schema: enumObject.schema && enumObject.schema.length > 0 ? enumObject.schema : "public",
    name: enumObject.enumName,
  };
}

function uniqueNames(items: readonly { schema: string; name: string }[]): InventoryName[] {
  const seen = new Set<string>();
  const names: InventoryName[] = [];
  for (const item of items) {
    const key = `${item.schema}.${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push({ schema: item.schema, name: item.name });
  }
  names.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
  return names;
}

function snapshotPartitionedTables(
  extras: PgExtras,
  nameOf: (column: AnyPgColumn) => string,
): PartitionedTableSnapshot[] {
  const tables: PartitionedTableSnapshot[] = [];
  for (const table of extras.partitionedTables) {
    const identity = tableIdentity(table.table);
    const columns = table.columns.map((column) => (typeof column === "string" ? column : nameOf(column)));
    const snap: PartitionedTableSnapshot = {
      id: JSON.stringify(["partitioned", identity.schema, identity.name]),
      schema: identity.schema,
      name: identity.name,
      method: table.method,
      columns,
    };
    if (tables.some((item) => item.id === snap.id)) {
      throw new PgExtrasError(`partitioned table ${identity.schema}.${identity.name} is declared more than once`);
    }
    tables.push(snap);
  }
  return tables;
}

function snapshotPartitions(extras: PgExtras, parents: readonly PartitionedTableSnapshot[]): PartitionSnapshot[] {
  const partitions: PartitionSnapshot[] = [];
  const childIds = new Set<string>();
  const defaults = new Set<string>();
  const hashSlots = new Set<string>();
  for (const partition of extras.partitions) {
    const parent = parentIdentity(partition);
    const declared = parents.find((item) => item.schema === parent.schema && item.name === parent.name);
    if (!declared) {
      throw new PgExtrasError(
        `partition "${partition.name}" refers to ${parent.schema}.${parent.name}, which has no partitionedTable(). Declare the parent as well`,
      );
    }
    assertBoundMatches(partition, declared);
    const schema = partition.schema ?? declared.schema;
    const snap: PartitionSnapshot = {
      id: JSON.stringify(["partition", declared.schema, declared.name, schema, partition.name]),
      schema,
      name: partition.name,
      parentSchema: declared.schema,
      parentName: declared.name,
      mode: partition.mode,
      onRemove: partition.onRemove,
      boundKind: partition.bound.kind,
      boundSql: boundSqlOf(partition, declared.columns.length),
    };
    if (partitions.some((item) => item.id === snap.id)) {
      throw new PgExtrasError(`partition ${schema}.${partition.name} of ${declared.schema}.${declared.name} is declared more than once`);
    }
    const childId = JSON.stringify([schema, partition.name]);
    if (childIds.has(childId)) {
      throw new PgExtrasError(`table ${schema}.${partition.name} is declared as a partition more than once`);
    }
    childIds.add(childId);
    if (partition.bound.kind === "default") {
      const parentId = JSON.stringify([declared.schema, declared.name]);
      if (defaults.has(parentId)) {
        throw new PgExtrasError(`partitioned table ${declared.schema}.${declared.name} has more than one DEFAULT partition`);
      }
      defaults.add(parentId);
    }
    if (partition.bound.kind === "hash") {
      const slot = JSON.stringify([declared.schema, declared.name, partition.bound.modulus, partition.bound.remainder]);
      if (hashSlots.has(slot)) {
        throw new PgExtrasError(
          `partition ${schema}.${partition.name} repeats modulus ${partition.bound.modulus} remainder ${partition.bound.remainder}`,
        );
      }
      hashSlots.add(slot);
    }
    partitions.push(snap);
  }
  return partitions;
}

function snapshotDetaches(extras: PgExtras, partitions: readonly PartitionSnapshot[]): DetachSnapshot[] {
  const detaches: DetachSnapshot[] = [];
  for (const detach of extras.detaches) {
    const child = tableIdentity(detach.table);
    const parent = parentIdentity(detach);
    const snap: DetachSnapshot = {
      id: JSON.stringify(["detach", parent.schema, parent.name, child.schema, child.name]),
      schema: child.schema,
      name: child.name,
      parentSchema: parent.schema,
      parentName: parent.name,
    };
    if (detaches.some((item) => item.id === snap.id)) {
      throw new PgExtrasError(`detach of ${child.schema}.${child.name} from ${parent.schema}.${parent.name} is declared more than once`);
    }
    if (partitions.some((item) => item.schema === child.schema && item.name === child.name && item.parentSchema === parent.schema && item.parentName === parent.name)) {
      throw new PgExtrasError(
        `${child.schema}.${child.name} is both attached to and detached from ${parent.schema}.${parent.name}`,
      );
    }
    detaches.push(snap);
  }
  return detaches;
}

function parentIdentity(value: PgPartition | PgDetach): { schema: string; name: string } {
  const parent = value.parent;
  if (extrasKind(parent) === "partitionedTable") return tableIdentity((parent as PartitionedTable).table);
  return tableIdentity(parent as PgTable | { name: string; schema?: string });
}

function assertBoundMatches(partition: PgPartition, parent: PartitionedTableSnapshot): void {
  const label = `partition "${partition.schema ?? parent.schema}.${partition.name}"`;
  const kind = partition.bound.kind;
  if (parent.method === "hash" && kind === "default") {
    throw new PgExtrasError(`${label}: a hash-partitioned table cannot have a DEFAULT partition`);
  }
  if (parent.method === "range" && kind !== "range" && kind !== "default") {
    throw new PgExtrasError(`${label}: ${parent.schema}.${parent.name} is partitioned by range, so use from/to or default`);
  }
  if (parent.method === "list" && kind !== "list" && kind !== "default") {
    throw new PgExtrasError(`${label}: ${parent.schema}.${parent.name} is partitioned by list, so use in or default`);
  }
  if (parent.method === "hash" && kind !== "hash") {
    throw new PgExtrasError(`${label}: ${parent.schema}.${parent.name} is partitioned by hash, so use modulus and remainder`);
  }
  if (kind === "range" && partition.bound.kind === "range" && partition.bound.from.length !== parent.columns.length) {
    throw new PgExtrasError(
      `${label}: from and to need ${parent.columns.length} bound(s) for (${parent.columns.join(", ")})`,
    );
  }
}

function boundSqlOf(partition: PgPartition, keyCount: number): string {
  const label = `partition "${partition.name}"`;
  const bound = partition.bound;
  if (bound.kind === "default") return "DEFAULT";
  if (bound.kind === "range") {
    return `FOR VALUES FROM (${bound.from.map((value) => renderPartitionBound(value, "from")).join(", ")}) TO (${bound.to.map((value) => renderPartitionBound(value, "to")).join(", ")})`;
  }
  if (bound.kind === "list") {
    const values = bound.values.map((value) => {
      if (isBoundTuple(value)) {
        if (value.length !== keyCount) {
          throw new PgExtrasError(`${label}: each IN value needs ${keyCount} item(s), one per partition column`);
        }
        return `(${value.map((item) => renderPartitionBound(item, "list")).join(", ")})`;
      }
      if (keyCount !== 1) {
        throw new PgExtrasError(`${label}: a ${keyCount}-column list partition needs tuples, such as in: [["a", 1]]`);
      }
      return renderPartitionBound(value, "list");
    });
    return `FOR VALUES IN (${values.join(", ")})`;
  }
  return `FOR VALUES WITH (MODULUS ${bound.modulus}, REMAINDER ${bound.remainder})`;
}

function isBoundTuple(value: PartitionBound | readonly PartitionBound[]): value is readonly PartitionBound[] {
  return Array.isArray(value);
}

function renderPartitionBound(value: PartitionBound, side: "from" | "to" | "list"): string {
  if (value === "MINVALUE") {
    if (side !== "from") throw new PgExtrasError('MINVALUE is only valid in a range partition "from" bound');
    return "MINVALUE";
  }
  if (value === "MAXVALUE") {
    if (side !== "to") throw new PgExtrasError('MAXVALUE is only valid in a range partition "to" bound');
    return "MAXVALUE";
  }
  if (typeof value === "string") return quoteLiteral(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PgExtrasError("partition bound must be a finite number");
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value === null) return "NULL";
  throw new PgExtrasError("partition bound must be a string, number, boolean, null, bigint, MINVALUE, or MAXVALUE");
}

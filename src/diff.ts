import { PgExtrasError } from "./errors.js";
import {
  attachPartitionSql,
  convertPartitionedTableSql,
  createPartitionSql,
  detachPartitionSql,
  dropPartitionSql,
} from "./partition-sql.js";
import { quoteIdent, quoteLiteral } from "./quote.js";
import type { CommentSnapshot, InventoryView, PartitionedTableSnapshot, Snapshot, TriggerSnapshot } from "./snapshot.js";
import { functionSignature, sameFunction, sameTrigger } from "./snapshot.js";
import {
  commentSql,
  createExtensionSql,
  createFunctionSql,
  createTriggerSql,
  dropExtensionSql,
  dropFunctionSql,
  dropTriggerSql,
} from "./statements.js";

export type SqlDiff = {
  up: string[];
  down: string[];
};

export function diffSnapshots(from: Snapshot, to: Snapshot): SqlDiff {
  return {
    up: statementsBetween(from, to, true),
    down: statementsBetween(to, from, false),
  };
}

/**
 * Idempotent SQL for the whole snapshot. Useful after `drizzle-kit push`, which
 * does not run migration files. It does not drop objects removed from the snapshot.
 */
export function idempotentStatements(snapshot: Snapshot): string[] {
  const statements: string[] = [];
  for (const ext of snapshot.extensions) statements.push(createExtensionSql(ext));
  const sqlFunctions = snapshot.functions.some((fn) => fn.language === "sql");
  if (sqlFunctions) statements.push("SET check_function_bodies = off");
  for (const fn of snapshot.functions) statements.push(createFunctionSql(fn));
  if (sqlFunctions) statements.push("SET check_function_bodies = on");
  statements.push(...partitionStatements(snapshot));
  for (const comment of snapshot.comments) {
    if (comment.kind !== "trigger") statements.push(commentSql(comment, comment.text));
  }
  for (const trigger of snapshot.triggers) statements.push(createTriggerSql(trigger));
  for (const comment of snapshot.comments) {
    if (comment.kind === "trigger") statements.push(commentSql(comment, comment.text));
  }
  return statements;
}

function partitionStatements(snapshot: Snapshot): string[] {
  const statements: string[] = [];
  for (const parent of snapshot.partitionedTables) statements.push(convertPartitionedTableSql(parent, "partition"));
  for (const partition of snapshot.partitions) {
    statements.push(partition.mode === "attach" ? attachPartitionSql(partition) : createPartitionSql(partition));
  }
  for (const detach of snapshot.detaches) statements.push(detachPartitionSql(detach));
  return statements;
}

function statementsBetween(from: Snapshot, to: Snapshot, skipDroppedTables: boolean): string[] {
  const fromFns = new Map(from.functions.map((fn) => [fn.id, fn]));
  const toFns = new Map(to.functions.map((fn) => [fn.id, fn]));
  const fromTriggers = new Map(from.triggers.map((trigger) => [trigger.id, trigger]));
  const toTriggers = new Map(to.triggers.map((trigger) => [trigger.id, trigger]));
  const fromExt = new Map(from.extensions.map((ext) => [ext.id, ext]));
  const toExt = new Map(to.extensions.map((ext) => [ext.id, ext]));
  const fromComments = new Map(from.comments.map((comment) => [comment.id, comment]));
  const toComments = new Map(to.comments.map((comment) => [comment.id, comment]));

  const dropFnIds = new Set<string>();
  for (const [id, fn] of fromFns) {
    const next = toFns.get(id);
    if (!next || next.returns !== fn.returns) dropFnIds.add(id);
  }

  const triggersToDrop: TriggerSnapshot[] = [];
  for (const trigger of from.triggers) {
    const next = toTriggers.get(trigger.id);
    const fnDropped = trigger.functionId !== null && dropFnIds.has(trigger.functionId);
    if ((!next || fnDropped) && !(skipDroppedTables && tableGone(from, to, trigger.schema, trigger.table))) {
      triggersToDrop.push(trigger);
    }
  }
  triggersToDrop.sort((a, b) => a.id.localeCompare(b.id));
  const droppedTriggerIds = new Set(triggersToDrop.map((trigger) => trigger.id));

  const statements: string[] = [];
  for (const trigger of triggersToDrop) statements.push(dropTriggerSql(trigger));
  statements.push(...partitionChanges(from, to, skipDroppedTables));

  const fnIds = [...dropFnIds].sort();
  for (const id of fnIds) statements.push(dropFunctionSql(fromFns.get(id)!));

  for (const ext of [...to.extensions].sort((a, b) => a.id.localeCompare(b.id))) {
    const prev = fromExt.get(ext.id);
    if (!prev) {
      statements.push(createExtensionSql(ext));
      continue;
    }
    if (ext.schema && prev.schema !== ext.schema) {
      statements.push(`ALTER EXTENSION ${quoteIdent(ext.name)} SET SCHEMA ${quoteIdent(ext.schema)};`);
    }
    if (ext.version && prev.version !== ext.version) {
      statements.push(`ALTER EXTENSION ${quoteIdent(ext.name)} UPDATE TO ${quoteLiteral(ext.version)};`);
    }
  }

  const fnsToWrite = to.functions.filter((fn) => {
    const prev = fromFns.get(fn.id);
    return !prev || !sameFunction(prev, fn);
  });
  const needsBodyOff = fnsToWrite.some((fn) => fn.language === "sql");
  if (needsBodyOff) statements.push("SET check_function_bodies = off");
  for (const fn of fnsToWrite) statements.push(createFunctionSql(fn));
  if (needsBodyOff) statements.push("SET check_function_bodies = on");

  emitComments(statements, from, to, fromComments, toComments, dropFnIds, toFns, droppedTriggerIds, toTriggers, toExt, skipDroppedTables, "other");

  for (const trigger of to.triggers) {
    const prev = fromTriggers.get(trigger.id);
    if (!prev || !sameTrigger(prev, trigger) || droppedTriggerIds.has(trigger.id)) {
      statements.push(createTriggerSql(trigger));
    }
  }

  emitComments(statements, from, to, fromComments, toComments, dropFnIds, toFns, droppedTriggerIds, toTriggers, toExt, skipDroppedTables, "trigger");

  for (const ext of [...from.extensions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!toExt.has(ext.id)) statements.push(dropExtensionSql(ext));
  }

  return statements;
}

function emitComments(
  statements: string[],
  from: Snapshot,
  to: Snapshot,
  fromComments: Map<string, CommentSnapshot>,
  toComments: Map<string, CommentSnapshot>,
  dropFnIds: Set<string>,
  toFns: Map<string, Snapshot["functions"][number]>,
  droppedTriggerIds: Set<string>,
  toTriggers: Map<string, TriggerSnapshot>,
  toExt: Map<string, Snapshot["extensions"][number]>,
  skipDroppedTables: boolean,
  mode: "trigger" | "other",
): void {
  const ids = [...new Set([...fromComments.keys(), ...toComments.keys()])].sort();
  for (const id of ids) {
    const prev = fromComments.get(id);
    const next = toComments.get(id);
    const subject = next ?? prev;
    if (!subject) continue;
    if (mode === "trigger" ? subject.kind !== "trigger" : subject.kind === "trigger") continue;
    if (prev && next && prev.text === next.text && !commentRewritten(next, dropFnIds, toFns, droppedTriggerIds, toTriggers)) {
      continue;
    }
    if (!next && prev) {
      if (skipCommentNull(prev, to, toFns, toTriggers, toExt, skipDroppedTables, from)) continue;
      statements.push(commentSql(prev, null));
      continue;
    }
    if (next) statements.push(commentSql(next, next.text));
  }
}

function commentRewritten(
  comment: CommentSnapshot,
  dropFnIds: Set<string>,
  toFns: Map<string, Snapshot["functions"][number]>,
  droppedTriggerIds: Set<string>,
  toTriggers: Map<string, TriggerSnapshot>,
): boolean {
  if (comment.kind === "function") {
    const id = functionSignature(comment.schema, comment.name, comment.argTypes ?? []);
    return dropFnIds.has(id) && toFns.has(id);
  }
  if (comment.kind === "trigger") return droppedTriggerIds.has(comment.id) && toTriggers.has(comment.id);
  return false;
}

function skipCommentNull(
  comment: CommentSnapshot,
  to: Snapshot,
  toFns: Map<string, Snapshot["functions"][number]>,
  toTriggers: Map<string, TriggerSnapshot>,
  toExt: Map<string, Snapshot["extensions"][number]>,
  skipDroppedTables: boolean,
  from: Snapshot,
): boolean {
  if (comment.kind === "function") return !toFns.has(functionSignature(comment.schema, comment.name, comment.argTypes ?? []));
  if (comment.kind === "trigger") return !toTriggers.has(comment.id);
  if (comment.kind === "extension") return !toExt.has(comment.name);
  return skipDroppedTables && targetGone(from, to, comment);
}

function partitionChanges(from: Snapshot, to: Snapshot, skipDroppedTables: boolean): string[] {
  const statements: string[] = [];
  const handled = new Set<string>();
  const fromParents = new Map(from.partitionedTables.map((item) => [item.id, item]));
  const toParents = new Map(to.partitionedTables.map((item) => [item.id, item]));
  const fromPartitions = new Map(from.partitions.map((item) => [item.id, item]));
  const toPartitions = new Map(to.partitions.map((item) => [item.id, item]));
  const fromDetaches = new Set(from.detaches.map((item) => item.id));

  for (const partition of from.partitions) {
    if (toPartitions.has(partition.id)) continue;
    if (
      skipDroppedTables &&
      (tableGone(from, to, partition.parentSchema, partition.parentName) || tableGone(from, to, partition.schema, partition.name))
    ) {
      continue;
    }
    if (partition.mode === "attach" || partition.onRemove === "detach") statements.push(detachPartitionSql(partition));
    else statements.push(dropPartitionSql(partition));
    handled.add(childKey(partition.schema, partition.name, partition.parentSchema, partition.parentName));
  }

  for (const parent of from.partitionedTables) {
    if (toParents.has(parent.id)) continue;
    if (skipDroppedTables && tableGone(from, to, parent.schema, parent.name)) continue;
    statements.push(convertPartitionedTableSql(parent, "unpartition"));
  }

  for (const parent of to.partitionedTables) {
    const previous = fromParents.get(parent.id);
    if (!previous) {
      statements.push(convertPartitionedTableSql(parent, "partition"));
      continue;
    }
    if (previous.method !== parent.method || previous.columns.join("\0") !== parent.columns.join("\0")) {
      throw new PgExtrasError(
        `partitioned table ${parent.schema}.${parent.name} changed from ${describeKey(previous)} to ${describeKey(parent)}. Postgres cannot change a partition key in place. Keep the original partitionedTable() and move the data in a custom migration if you need a different key.`,
      );
    }
  }

  for (const partition of to.partitions) {
    const previous = fromPartitions.get(partition.id);
    if (!previous) {
      statements.push(partition.mode === "attach" ? attachPartitionSql(partition) : createPartitionSql(partition));
      continue;
    }
    if (previous.mode !== partition.mode || previous.boundSql !== partition.boundSql || previous.boundKind !== partition.boundKind) {
      throw new PgExtrasError(
        `partition ${partition.schema}.${partition.name} of ${partition.parentSchema}.${partition.parentName} changed (${previous.mode} ${previous.boundSql} -> ${partition.mode} ${partition.boundSql}). Postgres cannot alter partition bounds in place, and this package will not detach and recreate a partition because that drops rows. Move the rows in a custom migration.`,
      );
    }
  }

  for (const detach of to.detaches) {
    if (fromDetaches.has(detach.id)) continue;
    if (handled.has(childKey(detach.schema, detach.name, detach.parentSchema, detach.parentName))) continue;
    if (skipDroppedTables && (tableGone(from, to, detach.parentSchema, detach.parentName) || tableGone(from, to, detach.schema, detach.name))) {
      continue;
    }
    statements.push(detachPartitionSql(detach));
  }

  return statements;
}

function childKey(schema: string, name: string, parentSchema: string, parentName: string): string {
  return JSON.stringify([schema, name, parentSchema, parentName]);
}

function describeKey(parent: PartitionedTableSnapshot): string {
  return `${parent.method.toUpperCase()} (${parent.columns.join(", ")})`;
}

function tableGone(from: Snapshot, to: Snapshot, schema: string, table: string): boolean {
  if (!from.inventory.scanned || !to.inventory.scanned) return false;
  const had = from.inventory.tables.some((item) => item.schema === schema && item.name === table);
  const has = to.inventory.tables.some((item) => item.schema === schema && item.name === table);
  return had && !has;
}

function targetGone(from: Snapshot, to: Snapshot, comment: CommentSnapshot): boolean {
  if (!from.inventory.scanned || !to.inventory.scanned) return false;
  const relation = comment.relation ?? comment.name;
  if (comment.kind === "table" || comment.kind === "column") {
    if (tableGone(from, to, comment.schema, relation)) return true;
    if (comment.kind !== "column" || !comment.column) return false;
    const prev = from.inventory.tables.find((item) => item.schema === comment.schema && item.name === relation);
    const next = to.inventory.tables.find((item) => item.schema === comment.schema && item.name === relation);
    if (prev && next) return prev.columns.includes(comment.column) && !next.columns.includes(comment.column);
    return viewColumnGone(from, to, comment.schema, relation, comment.column);
  }
  if (comment.kind === "enum") return namedGone(from.inventory.enums, to.inventory.enums, comment.schema, comment.name);
  if (comment.kind === "view" || comment.kind === "materializedView") {
    return viewGone(from.inventory.views, to.inventory.views, comment.schema, comment.name, comment.kind === "materializedView");
  }
  if (comment.kind === "index") {
    return listedGone(from.inventory.indexes, to.inventory.indexes, comment.schema, comment.name);
  }
  if (comment.kind === "constraint") {
    const had = from.inventory.constraints.some((item) => item.schema === comment.schema && item.table === relation && item.name === comment.name);
    const has = to.inventory.constraints.some((item) => item.schema === comment.schema && item.table === relation && item.name === comment.name);
    return had && !has;
  }
  return false;
}

function namedGone(from: readonly { schema: string; name: string }[], to: readonly { schema: string; name: string }[], schema: string, name: string): boolean {
  const had = from.some((item) => item.schema === schema && item.name === name);
  const has = to.some((item) => item.schema === schema && item.name === name);
  return had && !has;
}

function listedGone(from: readonly { schema: string; name: string }[], to: readonly { schema: string; name: string }[], schema: string, name: string): boolean {
  return namedGone(from, to, schema, name);
}

function viewGone(from: readonly InventoryView[], to: readonly InventoryView[], schema: string, name: string, materialized: boolean): boolean {
  const had = from.some((item) => item.schema === schema && item.name === name && item.materialized === materialized);
  const has = to.some((item) => item.schema === schema && item.name === name && item.materialized === materialized);
  return had && !has;
}

function viewColumnGone(from: Snapshot, to: Snapshot, schema: string, relation: string, column: string): boolean {
  const prev = from.inventory.views.find((item) => item.schema === schema && item.name === relation);
  const next = to.inventory.views.find((item) => item.schema === schema && item.name === relation);
  if (prev && !next) return true;
  if (!prev || !next) return false;
  return prev.columns.includes(column) && !next.columns.includes(column);
}

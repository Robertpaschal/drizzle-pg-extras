import { quoteIdent, quoteLiteral } from "./quote.js";
import type { CommentSnapshot, Snapshot, TriggerSnapshot } from "./snapshot.js";
import { sameFunction, sameTrigger } from "./snapshot.js";
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
  for (const comment of snapshot.comments) statements.push(commentSql(comment, comment.text));
  for (const trigger of snapshot.triggers) statements.push(createTriggerSql(trigger));
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

  const statements: string[] = [];
  for (const trigger of triggersToDrop) statements.push(dropTriggerSql(trigger));

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

  const commentIds = new Set([...fromComments.keys(), ...toComments.keys()]);
  for (const id of [...commentIds].sort()) {
    const prev = fromComments.get(id);
    const next = toComments.get(id);
    if (prev && next && prev.text === next.text) continue;
    if (!next && prev) {
      if (skipDroppedTables && targetGone(from, to, prev)) continue;
      statements.push(commentSql(prev, null));
      continue;
    }
    if (next) statements.push(commentSql(next, next.text));
  }

  const droppedTriggerIds = new Set(triggersToDrop.map((trigger) => trigger.id));
  for (const trigger of to.triggers) {
    const prev = fromTriggers.get(trigger.id);
    if (!prev || !sameTrigger(prev, trigger) || droppedTriggerIds.has(trigger.id)) {
      statements.push(createTriggerSql(trigger));
    }
  }

  for (const ext of [...from.extensions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!toExt.has(ext.id)) statements.push(dropExtensionSql(ext));
  }

  return statements;
}

function tableGone(from: Snapshot, to: Snapshot, schema: string, table: string): boolean {
  if (!from.inventory.scanned || !to.inventory.scanned) return false;
  const had = from.inventory.tables.some((item) => item.schema === schema && item.name === table);
  const has = to.inventory.tables.some((item) => item.schema === schema && item.name === table);
  return had && !has;
}

function targetGone(from: Snapshot, to: Snapshot, comment: CommentSnapshot): boolean {
  if (tableGone(from, to, comment.schema, comment.table)) return true;
  if (comment.kind !== "column" || !comment.column) return false;
  if (!from.inventory.scanned || !to.inventory.scanned) return false;
  const prev = from.inventory.tables.find((item) => item.schema === comment.schema && item.name === comment.table);
  const next = to.inventory.tables.find((item) => item.schema === comment.schema && item.name === comment.table);
  if (!prev || !next) return false;
  return prev.columns.includes(comment.column) && !next.columns.includes(comment.column);
}

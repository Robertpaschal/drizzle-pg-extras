import { is } from "drizzle-orm";
import { PgTable, isPgEnum, isPgMaterializedView, isPgView } from "drizzle-orm/pg-core";
import {
  extrasKind,
  isPlainRecord,
  type AnyPgEnum,
  type PartitionedTable,
  type PgComment,
  type PgDetach,
  type PgExtras,
  type PgExtension,
  type PgFunction,
  type PgPartition,
  type PgTrigger,
  type PgViewLike,
} from "./defs.js";

export function collectExtras(modules: Record<string, unknown> | readonly Record<string, unknown>[]): PgExtras {
  const extras: PgExtras = {
    functions: [],
    triggers: [],
    extensions: [],
    comments: [],
    tables: [],
    enums: [],
    views: [],
    partitionedTables: [],
    partitions: [],
    detaches: [],
  };
  const seen = new Set<unknown>();
  const list = Array.isArray(modules) ? modules : [modules];
  for (const mod of list) walk(mod, extras, seen);
  for (const trigger of extras.triggers) {
    const fn = trigger.function;
    if (fn && extrasKind(fn) === "function" && !extras.functions.includes(fn as PgFunction)) {
      extras.functions.push(fn as PgFunction);
    }
  }
  return extras;
}

export function defineExtras(input: {
  functions?: readonly PgFunction[];
  triggers?: readonly PgTrigger[];
  extensions?: readonly PgExtension[];
  comments?: readonly PgComment[];
  tables?: readonly PgTable[];
  enums?: readonly AnyPgEnum[];
  views?: readonly PgViewLike[];
  partitionedTables?: readonly PartitionedTable[];
  partitions?: readonly PgPartition[];
  detaches?: readonly PgDetach[];
}): PgExtras {
  return collectExtras({
    functions: input.functions ?? [],
    triggers: input.triggers ?? [],
    extensions: input.extensions ?? [],
    comments: input.comments ?? [],
    tables: input.tables ?? [],
    enums: input.enums ?? [],
    views: input.views ?? [],
    partitionedTables: input.partitionedTables ?? [],
    partitions: input.partitions ?? [],
    detaches: input.detaches ?? [],
  });
}

function walk(value: unknown, extras: PgExtras, seen: Set<unknown>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "function") {
    if (isPgEnum(value)) pushEnum(extras, value);
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  const kind = extrasKind(value);
  if (kind === "function") {
    extras.functions.push(value as PgFunction);
    return;
  }
  if (kind === "trigger") {
    extras.triggers.push(value as PgTrigger);
    return;
  }
  if (kind === "extension") {
    extras.extensions.push(value as PgExtension);
    return;
  }
  if (kind === "comment") {
    extras.comments.push(value as PgComment);
    return;
  }
  if (kind === "partitionedTable") {
    const partitioned = value as PartitionedTable;
    extras.partitionedTables.push(partitioned);
    if (is(partitioned.table, PgTable)) walk(partitioned.table, extras, seen);
    return;
  }
  if (kind === "partition") {
    extras.partitions.push(value as PgPartition);
    return;
  }
  if (kind === "detach") {
    extras.detaches.push(value as PgDetach);
    return;
  }
  if (isPgView(value) || isPgMaterializedView(value)) {
    pushView(extras, value);
    return;
  }
  if (is(value, PgTable)) {
    if (!extras.tables.includes(value)) extras.tables.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, extras, seen);
    return;
  }
  if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) walk(entry, extras, seen);
  }
}

function pushEnum(extras: PgExtras, value: unknown): void {
  const enumObject = value as AnyPgEnum;
  if (!extras.enums.includes(enumObject)) extras.enums.push(enumObject);
}

function pushView(extras: PgExtras, value: PgViewLike): void {
  if (!extras.views.includes(value)) extras.views.push(value);
}

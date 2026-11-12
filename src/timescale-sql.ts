import { PgExtrasError } from "./errors.js";
import { qualify, quoteIdent, quoteLiteral } from "./quote.js";
import type { HypertableCompressionSnapshot, HypertableSnapshot } from "./snapshot.js";

export function createHypertableStatements(ht: HypertableSnapshot): string[] {
  const statements = [createHypertableSql(ht)];
  if (ht.compression) statements.push(enableHypertableCompressionSql(ht, ht.compression, null));
  if (ht.compressionPolicy) statements.push(addCompressionPolicySql(ht));
  if (ht.retention) statements.push(addRetentionPolicySql(ht));
  return statements;
}

export function createHypertableSql(ht: HypertableSnapshot): string {
  const args = [relation(ht), nameLiteral(ht.timeColumn)];
  if (ht.partitioningColumn) {
    args.push(`partitioning_column => ${nameLiteral(ht.partitioningColumn)}`);
    args.push(`number_partitions => ${ht.numberPartitions}`);
  }
  if (ht.chunkTimeInterval) args.push(`chunk_time_interval => ${intervalLiteral(ht.chunkTimeInterval)}`);
  if (ht.migrateData) args.push("migrate_data => TRUE");
  args.push("if_not_exists => TRUE");
  const space = ht.partitioningColumn ? ` and ${quoteIdent(ht.partitioningColumn)}` : "";
  return `-- Convert ${qualify(ht.schema, ht.name)} into a TimescaleDB hypertable on ${quoteIdent(ht.timeColumn)}${space}.\nSELECT create_hypertable(${args.join(", ")});`;
}

export function setChunkTimeIntervalSql(ht: HypertableSnapshot): string {
  return `-- Set the chunk interval of ${qualify(ht.schema, ht.name)} to ${ht.chunkTimeInterval}.\nSELECT set_chunk_time_interval(${relation(ht)}, ${intervalLiteral(ht.chunkTimeInterval ?? "")});`;
}

export function addHypertableDimensionSql(ht: HypertableSnapshot): string {
  return `-- Add a space partition on ${quoteIdent(ht.partitioningColumn ?? "")} to ${qualify(ht.schema, ht.name)}.\nSELECT add_dimension(${relation(ht)}, ${nameLiteral(ht.partitioningColumn ?? "")}, number_partitions => ${ht.numberPartitions}, if_not_exists => TRUE);`;
}

export function enableHypertableCompressionSql(
  ht: Pick<HypertableSnapshot, "schema" | "name">,
  compression: HypertableCompressionSnapshot,
  previous: HypertableCompressionSnapshot | null,
): string {
  const options = ["timescaledb.compress"];
  const segment = compression.segmentBy.map((column) => quoteIdent(column)).join(", ");
  if (segment.length > 0 || (previous?.segmentBy.length ?? 0) > 0) {
    options.push(`timescaledb.compress_segmentby = ${quoteLiteral(segment)}`);
  }
  const order = compression.orderBy.map(orderFragment).join(", ");
  if (order.length > 0 || (previous?.orderBy.length ?? 0) > 0) {
    options.push(`timescaledb.compress_orderby = ${quoteLiteral(order)}`);
  }
  return `-- Enable compression on ${qualify(ht.schema, ht.name)}.\nALTER TABLE ${qualify(ht.schema, ht.name)} SET (\n  ${options.join(",\n  ")}\n);`;
}

export function disableHypertableCompressionSql(ht: Pick<HypertableSnapshot, "schema" | "name">): string {
  return `-- Turn compression off on ${qualify(ht.schema, ht.name)}.\nALTER TABLE ${qualify(ht.schema, ht.name)} SET (timescaledb.compress = false);`;
}

export function addRetentionPolicySql(ht: HypertableSnapshot): string {
  const policy = ht.retention;
  if (!policy) throw new PgExtrasError("addRetentionPolicySql requires a retention policy");
  return policySql(
    "Add a retention policy to",
    "add_retention_policy",
    ht,
    `drop_after => ${intervalLiteral(policy.dropAfter)}`,
    policy.scheduleInterval,
  );
}

export function removeRetentionPolicySql(ht: Pick<HypertableSnapshot, "schema" | "name">): string {
  return `-- Remove the retention policy from ${qualify(ht.schema, ht.name)}.\nSELECT remove_retention_policy(${relation(ht)}, if_exists => TRUE);`;
}

export function addCompressionPolicySql(ht: HypertableSnapshot): string {
  const policy = ht.compressionPolicy;
  if (!policy) throw new PgExtrasError("addCompressionPolicySql requires a compression policy");
  return policySql(
    "Add a compression policy to",
    "add_compression_policy",
    ht,
    `compress_after => ${intervalLiteral(policy.compressAfter)}`,
    policy.scheduleInterval,
  );
}

export function removeCompressionPolicySql(ht: Pick<HypertableSnapshot, "schema" | "name">): string {
  return `-- Remove the compression policy from ${qualify(ht.schema, ht.name)}.\nSELECT remove_compression_policy(${relation(ht)}, if_exists => TRUE);`;
}

export function leaveHypertableDimensionSql(ht: HypertableSnapshot): string {
  return `-- ${qualify(ht.schema, ht.name)} keeps its space partition on ${quoteIdent(ht.partitioningColumn ?? "")}. This migration does not drop a hash dimension.\nDO $drizzle_pg_extras$\nBEGIN\n  RAISE NOTICE 'drizzle-pg-extras: %.% keeps space partition %', ${quoteLiteral(ht.schema)}, ${quoteLiteral(ht.name)}, ${quoteLiteral(ht.partitioningColumn ?? "")};\nEND\n$drizzle_pg_extras$;`;
}

export function leaveChunkIntervalSql(ht: HypertableSnapshot): string {
  return `-- ${qualify(ht.schema, ht.name)} keeps chunk interval ${ht.chunkTimeInterval}. Clearing chunkTimeInterval is not generated.\nDO $drizzle_pg_extras$\nBEGIN\n  RAISE NOTICE 'drizzle-pg-extras: %.% keeps chunk interval %', ${quoteLiteral(ht.schema)}, ${quoteLiteral(ht.name)}, ${quoteLiteral(ht.chunkTimeInterval ?? "")};\nEND\n$drizzle_pg_extras$;`;
}

export function leaveHypertableSql(ht: Pick<HypertableSnapshot, "schema" | "name">): string {
  return `-- ${qualify(ht.schema, ht.name)} stays a hypertable. TimescaleDB cannot turn it back into a regular table from this migration.\nDO $drizzle_pg_extras$\nBEGIN\n  RAISE NOTICE 'drizzle-pg-extras: %.% stays a hypertable', ${quoteLiteral(ht.schema)}, ${quoteLiteral(ht.name)};\nEND\n$drizzle_pg_extras$;`;
}

function policySql(
  comment: string,
  fn: string,
  ht: Pick<HypertableSnapshot, "schema" | "name">,
  age: string,
  scheduleInterval: string | null,
): string {
  const schedule = scheduleInterval ? `, schedule_interval => ${intervalLiteral(scheduleInterval)}` : "";
  return `-- ${comment} ${qualify(ht.schema, ht.name)}.\nSELECT ${fn}(${relation(ht)}, ${age}${schedule}, if_not_exists => TRUE);`;
}

function relation(ht: Pick<HypertableSnapshot, "schema" | "name">): string {
  return `${quoteLiteral(`${quoteIdent(ht.schema)}.${quoteIdent(ht.name)}`)}::regclass`;
}

function nameLiteral(name: string): string {
  return `${quoteLiteral(name)}::name`;
}

function intervalLiteral(value: string): string {
  return `INTERVAL ${quoteLiteral(value)}`;
}

function orderFragment(order: HypertableCompressionSnapshot["orderBy"][number]): string {
  const parts = [quoteIdent(order.column)];
  if (order.direction) parts.push(order.direction.toUpperCase());
  if (order.nulls) parts.push(`NULLS ${order.nulls.toUpperCase()}`);
  return parts.join(" ");
}

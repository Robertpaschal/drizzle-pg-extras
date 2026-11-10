export { PgExtrasError } from "./errors.js";
export { VERSION } from "./version.js";
export {
  pgFunction,
  pgTrigger,
  pgExtension,
  updatedAtTrigger,
  withComment,
  commentOn,
  readComment,
  type PgFunction,
  type PgFunctionArg,
  type PgFunctionConfig,
  type PgTrigger,
  type PgExtension,
  type PgComment,
  type PgExtras,
  type PgLanguage,
  type PgVolatility,
  type PgSecurity,
  type TriggerTiming,
  type TriggerEvent,
  type TriggerForEach,
  type TriggerArg,
  type RowRefs,
  type FunctionCall,
} from "./defs.js";
export { collectExtras, defineExtras } from "./collect.js";
export {
  snapshotExtras,
  emptySnapshot,
  parseSnapshot,
  type Snapshot,
  type FunctionSnapshot,
  type TriggerSnapshot,
  type ExtensionSnapshot,
  type CommentSnapshot,
} from "./snapshot.js";
export { diffSnapshots, idempotentStatements, type SqlDiff } from "./diff.js";
export {
  generate,
  loadStoredSnapshot,
  pendingStatements,
  planExtras,
  renderIdempotent,
  type GenerateOptions,
  type GenerateResult,
} from "./generate.js";
export { splitMigrationSql, joinStatements, BREAKPOINT } from "./journal.js";
export {
  createFunctionSql,
  dropFunctionSql,
  createTriggerSql,
  dropTriggerSql,
  createExtensionSql,
  dropExtensionSql,
  commentSql,
} from "./statements.js";

import { dollarQuote, qualify, quoteIdent, quoteLiteral } from "./quote.js";
import type { CommentSnapshot, ExtensionSnapshot, FunctionSnapshot, TriggerSnapshot } from "./snapshot.js";

export function createFunctionSql(fn: FunctionSnapshot): string {
  const args = fn.args
    .map((arg) => {
      const name = arg.name ? `${quoteIdent(arg.name)} ` : "";
      const def = arg.defaultExpr !== null ? ` DEFAULT ${arg.defaultExpr}` : "";
      return `${name}${arg.type}${def}`;
    })
    .join(", ");
  const lines = [
    `CREATE OR REPLACE FUNCTION ${qualify(fn.schema, fn.name)}(${args})`,
    `RETURNS ${fn.returns}`,
    `LANGUAGE ${fn.language}`,
    fn.volatility.toUpperCase(),
  ];
  if (fn.strict) lines.push("STRICT");
  lines.push(fn.security === "definer" ? "SECURITY DEFINER" : "SECURITY INVOKER");
  if (fn.searchPath) lines.push(searchPathSql(fn.searchPath));
  lines.push(`AS ${dollarQuote(fn.body)};`);
  return lines.join("\n");
}

export function dropFunctionSql(fn: FunctionSnapshot): string {
  const types = fn.args.map((arg) => arg.type).join(", ");
  return `DROP FUNCTION IF EXISTS ${qualify(fn.schema, fn.name)}(${types});`;
}

export function createTriggerSql(trigger: TriggerSnapshot): string {
  const timing = trigger.timing === "instead of" ? "INSTEAD OF" : trigger.timing.toUpperCase();
  const events = trigger.events
    .map((event) => {
      if (event === "update" && trigger.columns.length > 0) {
        return `UPDATE OF ${trigger.columns.map((column) => quoteIdent(column)).join(", ")}`;
      }
      return event.toUpperCase();
    })
    .join(" OR ");
  const lines = [
    `CREATE OR REPLACE TRIGGER ${quoteIdent(trigger.name)}`,
    `${timing} ${events} ON ${qualify(trigger.schema, trigger.table)}`,
    `FOR EACH ${trigger.forEach.toUpperCase()}`,
  ];
  if (trigger.when) lines.push(`WHEN (${trigger.when})`);
  const args = trigger.functionArgsSql.join(", ");
  lines.push(`EXECUTE FUNCTION ${qualify(trigger.functionSchema, trigger.functionName)}(${args});`);
  return lines.join("\n");
}

export function dropTriggerSql(trigger: TriggerSnapshot): string {
  return `DROP TRIGGER IF EXISTS ${quoteIdent(trigger.name)} ON ${qualify(trigger.schema, trigger.table)};`;
}

export function createExtensionSql(ext: ExtensionSnapshot): string {
  let statement = `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(ext.name)}`;
  const options: string[] = [];
  if (ext.schema) options.push(`SCHEMA ${quoteIdent(ext.schema)}`);
  if (ext.version) options.push(`VERSION ${quoteLiteral(ext.version)}`);
  if (options.length > 0) statement += ` WITH ${options.join(" ")}`;
  if (ext.cascade) statement += " CASCADE";
  return `${statement};`;
}

export function dropExtensionSql(ext: ExtensionSnapshot): string {
  return `DROP EXTENSION IF EXISTS ${quoteIdent(ext.name)}${ext.cascade ? " CASCADE" : ""};`;
}

export function commentSql(comment: CommentSnapshot, text: string | null): string {
  const target =
    comment.kind === "table"
      ? `TABLE ${qualify(comment.schema, comment.table)}`
      : `COLUMN ${qualify(comment.schema, comment.table)}.${quoteIdent(comment.column ?? "")}`;
  return `COMMENT ON ${target} IS ${text === null ? "NULL" : quoteLiteral(text)};`;
}

function searchPathSql(paths: readonly string[]): string {
  if (paths.length === 0) return "SET search_path TO ''";
  return `SET search_path TO ${paths.map((entry) => quoteLiteral(entry)).join(", ")}`;
}

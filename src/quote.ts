import { PgExtrasError } from "./errors.js";

export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new PgExtrasError("SQL identifier is empty");
  }
  if (name.includes("\0")) {
    throw new PgExtrasError("SQL identifier contains a null byte");
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  if (value.includes("\0")) {
    throw new PgExtrasError("SQL string literal contains a null byte");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export function assertIdentifier(kind: string, name: string): void {
  if (name.length === 0) {
    throw new PgExtrasError(`${kind} name is empty`);
  }
  if (name.includes("\0")) {
    throw new PgExtrasError(`${kind} name contains a null byte`);
  }
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes > 63) {
    throw new PgExtrasError(
      `${kind} name "${name}" is ${bytes} bytes. Postgres truncates identifiers at 63 bytes`,
    );
  }
}

const TYPE_ALIASES: Record<string, string> = {
  int: "integer",
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  bool: "boolean",
  float4: "real",
  float8: "double precision",
};

/** Collapse whitespace and a few aliases so signature identity stays stable. */
export function normalizeType(type: string): string {
  const trimmed = type.trim();
  if (trimmed.length === 0) {
    throw new PgExtrasError("function argument type is empty");
  }
  if (trimmed.includes('"')) {
    return trimmed.replace(/\s+/g, " ");
  }
  const collapsed = trimmed.replace(/\s+/g, " ").toLowerCase();
  return TYPE_ALIASES[collapsed] ?? collapsed;
}

export function dollarQuote(body: string): string {
  let tag = "function";
  let n = 0;
  while (body.includes(`$${tag}$`)) {
    n += 1;
    tag = `function${n}`;
  }
  return `$${tag}$\n${body}\n$${tag}$`;
}

import type { PartitionSnapshot, PartitionedTableSnapshot } from "./snapshot.js";
import { quoteIdent, quoteLiteral } from "./quote.js";

const STRATEGY_CHAR = { range: "r", list: "l", hash: "h" } as const;

export function convertPartitionedTableSql(
  parent: PartitionedTableSnapshot,
  direction: "partition" | "unpartition",
): string {
  const key = `${parent.method.toUpperCase()} (${parent.columns.map((column) => quoteIdent(column)).join(", ")})`;
  const comment =
    direction === "partition"
      ? `-- Convert empty ${quoteIdent(parent.schema)}.${quoteIdent(parent.name)} into a ${key} partitioned table. Refuses to run when the table has rows.`
      : `-- Convert partitioned ${quoteIdent(parent.schema)}.${quoteIdent(parent.name)} back into a regular table. Refuses to run when it has rows or still has partitions.`;
  const body = convertBody(parent, direction);
  return `${comment}\n${wrapDo(body)}`;
}

export function createPartitionSql(partition: PartitionSnapshot): string {
  const comment = `-- Create partition ${quoteIdent(partition.schema)}.${quoteIdent(partition.name)} of ${quoteIdent(partition.parentSchema)}.${quoteIdent(partition.parentName)} ${partition.boundSql}.`;
  return `${comment}\n${wrapDo(partitionBody(partition, "create"))}`;
}

export function attachPartitionSql(partition: PartitionSnapshot): string {
  const comment = `-- Attach ${quoteIdent(partition.schema)}.${quoteIdent(partition.name)} to ${quoteIdent(partition.parentSchema)}.${quoteIdent(partition.parentName)} ${partition.boundSql}.`;
  return `${comment}\n${wrapDo(partitionBody(partition, "attach"))}`;
}

export function detachPartitionSql(partition: Pick<PartitionSnapshot, "schema" | "name" | "parentSchema" | "parentName">): string {
  const comment = `-- Detach ${quoteIdent(partition.schema)}.${quoteIdent(partition.name)} from ${quoteIdent(partition.parentSchema)}.${quoteIdent(partition.parentName)}. The table is kept.`;
  return `${comment}\n${wrapDo(detachBody(partition))}`;
}

export function dropPartitionSql(partition: Pick<PartitionSnapshot, "schema" | "name" | "parentSchema" | "parentName">): string {
  const comment = `-- Drop empty partition ${quoteIdent(partition.schema)}.${quoteIdent(partition.name)}. Refuses to run when the partition has rows.`;
  return `${comment}\n${wrapDo(dropBody(partition))}`;
}

function convertBody(parent: PartitionedTableSnapshot, direction: "partition" | "unpartition"): string {
  const partitionBy = `${parent.method.toUpperCase()} (${parent.columns.map((column) => quoteIdent(column)).join(", ")})`;
  return `
DECLARE
  parent_schema text := ${quoteLiteral(parent.schema)};
  parent_name text := ${quoteLiteral(parent.name)};
  direction text := ${quoteLiteral(direction)};
  strategy "char" := ${quoteLiteral(STRATEGY_CHAR[parent.method])};
  key_columns name[] := ARRAY[${parent.columns.map((column) => `${quoteLiteral(column)}::name`).join(", ")}];
  partition_by text := ${quoteLiteral(partitionBy)};
  swap_name text := ${quoteLiteral(swapName(parent.name))};
  parent_oid oid;
  parent_kind "char";
  current_strategy "char";
  current_cols name[];
  current_natts integer;
  has_expression boolean;
  non_empty boolean;
  dependents text;
  indexes_json jsonb;
  constraints_json jsonb;
  sequences_json jsonb;
  incoming_json jsonb;
  triggers_json jsonb;
  policies_json jsonb;
  grants_json jsonb;
  owner_name text;
  table_comment text;
  replica "char";
  replica_index name;
  rel_options text[];
  rls boolean;
  force_rls boolean;
  item jsonb;
  match_oid oid;
  match_name name;
  seq_schema name;
  seq_name name;
  claimed oid[] := ARRAY[]::oid[];
  new_oid oid;
BEGIN
  SELECT c.oid, c.relkind
    INTO parent_oid, parent_kind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = parent_schema AND c.relname = parent_name AND c.relkind IN ('r', 'p');

  IF parent_oid IS NULL THEN
    IF direction = 'unpartition' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'drizzle-pg-extras: %.% does not exist. Run the drizzle-kit migration that creates this empty table before this one.', parent_schema, parent_name;
  END IF;

  IF direction = 'partition' AND parent_kind = 'p' THEN
    SELECT p.partstrat, p.partnatts,
           EXISTS (SELECT 1 FROM unnest(p.partattrs::smallint[]) AS u(attnum) WHERE u.attnum = 0),
           (
             SELECT array_agg(a.attname ORDER BY k.ord)
             FROM unnest(p.partattrs::smallint[]) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = parent_oid AND a.attnum = k.attnum
             WHERE k.attnum > 0
           )
      INTO current_strategy, current_natts, has_expression, current_cols
    FROM pg_partitioned_table p
    WHERE p.partrelid = parent_oid;

    IF current_strategy = strategy AND NOT has_expression AND current_natts = cardinality(key_columns) AND current_cols = key_columns THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'drizzle-pg-extras: %.% is already partitioned and its key does not match %. Partition keys cannot be changed in place.', parent_schema, parent_name, partition_by;
  END IF;

  IF direction = 'unpartition' AND parent_kind = 'r' THEN
    RETURN;
  END IF;

  IF parent_kind <> 'r' AND parent_kind <> 'p' THEN
    RAISE EXCEPTION 'drizzle-pg-extras: %.% is not a regular or partitioned table.', parent_schema, parent_name;
  END IF;

  IF direction = 'unpartition' THEN
    IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = parent_oid) THEN
      RAISE EXCEPTION 'drizzle-pg-extras: %.% still has child partitions. Detach or drop them before converting it back to a regular table.', parent_schema, parent_name;
    END IF;
  END IF;

  EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE', parent_schema, parent_name);

  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)', parent_schema, parent_name) INTO non_empty;
  IF non_empty THEN
    RAISE EXCEPTION 'drizzle-pg-extras: %.% has rows, so it cannot be converted. PARTITION BY is only valid on CREATE TABLE. Empty the table, or load data after this migration.', parent_schema, parent_name;
  END IF;

  SELECT string_agg(format('%I.%I', vn.nspname, vc.relname), ', ' ORDER BY vn.nspname, vc.relname)
    INTO dependents
  FROM pg_depend d
  JOIN pg_rewrite rw ON rw.oid = d.objid
  JOIN pg_class vc ON vc.oid = rw.ev_class
  JOIN pg_namespace vn ON vn.oid = vc.relnamespace
  WHERE d.refobjid = parent_oid
    AND d.classid = 'pg_rewrite'::regclass
    AND vc.oid <> parent_oid;
  IF dependents IS NOT NULL THEN
    RAISE EXCEPTION 'drizzle-pg-extras: %.% cannot be converted while these views depend on it: %. Drop the views first and recreate them after the conversion. The conversion recreates the table.', parent_schema, parent_name, dependents;
  END IF;

  IF to_regclass(format('%I.%I', parent_schema, swap_name)) IS NOT NULL THEN
    RAISE EXCEPTION 'drizzle-pg-extras: %.% already exists. Rename it before converting %.%.', parent_schema, swap_name, parent_schema, parent_name;
  END IF;

  SELECT c.relrowsecurity, c.relforcerowsecurity, c.relreplident, c.reloptions, pg_get_userbyid(c.relowner), obj_description(c.oid, 'pg_class')
    INTO rls, force_rls, replica, rel_options, owner_name, table_comment
  FROM pg_class c
  WHERE c.oid = parent_oid;

  SELECT ic.relname
    INTO replica_index
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  WHERE i.indrelid = parent_oid AND i.indisreplident;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', ic.relname,
    'primary', i.indisprimary,
    'unique', i.indisunique,
    'exclusion', i.indisexclusion,
    'cols', (
      SELECT coalesce(jsonb_agg(a.attname ORDER BY u.ord), '[]'::jsonb)
      FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS u(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum
      WHERE u.attnum > 0
    ),
    'exprs', pg_get_expr(i.indexprs, i.indrelid),
    'pred', pg_get_expr(i.indpred, i.indrelid)
  )), '[]'::jsonb)
    INTO indexes_json
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  WHERE i.indrelid = parent_oid;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', con.conname,
    'type', con.contype,
    'def', pg_get_constraintdef(con.oid),
    'self', con.confrelid = parent_oid
  )), '[]'::jsonb)
    INTO constraints_json
  FROM pg_constraint con
  WHERE con.conrelid = parent_oid AND con.contype IN ('c', 'f', 'p', 'u', 'x');

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'schema', sn.nspname,
    'name', sc.relname,
    'column', a.attname,
    'deptype', d.deptype::text
  )), '[]'::jsonb)
    INTO sequences_json
  FROM pg_depend d
  JOIN pg_class sc ON sc.oid = d.objid AND sc.relkind = 'S'
  JOIN pg_namespace sn ON sn.oid = sc.relnamespace
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid AND NOT a.attisdropped
  WHERE d.refobjid = parent_oid
    AND d.classid = 'pg_class'::regclass
    AND d.deptype IN ('a', 'i');

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'table', rel.relname,
    'name', con.conname,
    'def', pg_get_constraintdef(con.oid)
  )), '[]'::jsonb)
    INTO incoming_json
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
  WHERE con.confrelid = parent_oid AND con.contype = 'f' AND con.conrelid <> parent_oid;

  SELECT coalesce(jsonb_agg(jsonb_build_object('def', pg_get_triggerdef(t.oid))), '[]'::jsonb)
    INTO triggers_json
  FROM pg_trigger t
  WHERE t.tgrelid = parent_oid AND NOT t.tgisinternal;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', pol.polname,
    'permissive', pol.polpermissive,
    'cmd', pol.polcmd,
    'qual', pg_get_expr(pol.polqual, pol.polrelid),
    'check', pg_get_expr(pol.polwithcheck, pol.polrelid),
    'roles', CASE
      WHEN pol.polroles = ARRAY[0]::oid[] THEN 'PUBLIC'
      ELSE (
        SELECT string_agg(quote_ident(r.rolname), ', ' ORDER BY r.rolname)
        FROM pg_roles r
        WHERE r.oid = ANY (pol.polroles)
      )
    END
  )), '[]'::jsonb)
    INTO policies_json
  FROM pg_policy pol
  WHERE pol.polrelid = parent_oid;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'grantee', acl.grantee,
    'privilege', acl.privilege_type,
    'grantable', acl.is_grantable
  )), '[]'::jsonb)
    INTO grants_json
  FROM pg_class c, LATERAL aclexplode(c.relacl) AS acl
  WHERE c.oid = parent_oid;

  IF direction = 'partition' THEN
    EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL) PARTITION BY %s', parent_schema, swap_name, parent_schema, parent_name, partition_by);
  ELSE
    EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL)', parent_schema, swap_name, parent_schema, parent_name);
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(constraints_json) AS t(value)
  LOOP
    IF item->>'type' = 'f' AND COALESCE((item->>'self')::boolean, false) = false THEN
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', parent_schema, swap_name, item->>'name', item->>'def');
    END IF;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(sequences_json) AS t(value)
  LOOP
    IF item->>'deptype' = 'a' THEN
      EXECUTE format(
        'ALTER SEQUENCE %I.%I OWNED BY %I.%I.%I',
        item->>'schema', item->>'name', parent_schema, swap_name, item->>'column'
      );
    END IF;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(incoming_json) AS t(value)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', item->>'schema', item->>'table', item->>'name');
  END LOOP;

  EXECUTE format('DROP TABLE %I.%I', parent_schema, parent_name);
  EXECUTE format('ALTER TABLE %I.%I RENAME TO %I', parent_schema, swap_name, parent_name);

  SELECT c.oid INTO new_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = parent_schema AND c.relname = parent_name;

  FOR item IN SELECT value FROM jsonb_array_elements(indexes_json) AS t(value)
  LOOP
    SELECT i.indexrelid, ic.relname
      INTO match_oid, match_name
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = new_oid
      AND i.indexrelid <> ALL (claimed)
      AND i.indisprimary = (item->>'primary')::boolean
      AND i.indisunique = (item->>'unique')::boolean
      AND i.indisexclusion = (item->>'exclusion')::boolean
      AND coalesce(pg_get_expr(i.indexprs, i.indrelid), '') = coalesce(item->>'exprs', '')
      AND coalesce(pg_get_expr(i.indpred, i.indrelid), '') = coalesce(item->>'pred', '')
      AND (
        SELECT coalesce(jsonb_agg(a.attname ORDER BY u.ord), '[]'::jsonb)
        FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS u(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum
        WHERE u.attnum > 0
      ) = coalesce(item->'cols', '[]'::jsonb)
    LIMIT 1;

    IF match_oid IS NULL THEN
      RAISE EXCEPTION 'drizzle-pg-extras: could not restore index % on %.% after converting it.', item->>'name', parent_schema, parent_name;
    END IF;
    claimed := claimed || match_oid;
    IF match_name IS DISTINCT FROM item->>'name' THEN
      EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', parent_schema, match_name, item->>'name');
    END IF;
    match_oid := NULL;
    match_name := NULL;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(constraints_json) AS t(value)
  LOOP
    IF item->>'type' = 'f' THEN
      CONTINUE;
    END IF;
    SELECT con.conname
      INTO match_name
    FROM pg_constraint con
    WHERE con.conrelid = new_oid
      AND con.contype = item->>'type'
      AND pg_get_constraintdef(con.oid) = item->>'def'
    LIMIT 1;
    IF match_name IS NULL THEN
      RAISE EXCEPTION 'drizzle-pg-extras: could not restore constraint % on %.% after converting it.', item->>'name', parent_schema, parent_name;
    END IF;
    IF match_name IS DISTINCT FROM item->>'name' THEN
      EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I', parent_schema, parent_name, match_name, item->>'name');
    END IF;
    match_name := NULL;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(constraints_json) AS t(value)
  LOOP
    IF item->>'type' = 'f' AND COALESCE((item->>'self')::boolean, false) THEN
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', parent_schema, parent_name, item->>'name', item->>'def');
    END IF;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(incoming_json) AS t(value)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', item->>'schema', item->>'table', item->>'name', item->>'def');
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(sequences_json) AS t(value)
  LOOP
    IF item->>'deptype' <> 'i' THEN
      CONTINUE;
    END IF;
    SELECT sn.nspname, sc.relname
      INTO seq_schema, seq_name
    FROM pg_depend d
    JOIN pg_class sc ON sc.oid = d.objid AND sc.relkind = 'S'
    JOIN pg_namespace sn ON sn.oid = sc.relnamespace
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid AND NOT a.attisdropped
    WHERE d.refobjid = new_oid
      AND d.classid = 'pg_class'::regclass
      AND d.deptype = 'i'
      AND a.attname = item->>'column'
    LIMIT 1;
    IF seq_name IS NOT NULL AND seq_name IS DISTINCT FROM item->>'name' THEN
      EXECUTE format('ALTER SEQUENCE %I.%I RENAME TO %I', seq_schema, seq_name, item->>'name');
    END IF;
    seq_schema := NULL;
    seq_name := NULL;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(triggers_json) AS t(value)
  LOOP
    IF item->>'def' IS NOT NULL THEN
      EXECUTE item->>'def';
    END IF;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(policies_json) AS t(value)
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s',
      item->>'name',
      parent_schema,
      parent_name,
      CASE WHEN (item->>'permissive')::boolean THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      CASE item->>'cmd'
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        ELSE 'ALL'
      END,
      COALESCE(item->>'roles', 'PUBLIC'),
      CASE WHEN item->>'qual' IS NOT NULL THEN format(' USING (%s)', item->>'qual') ELSE '' END,
      CASE WHEN item->>'check' IS NOT NULL THEN format(' WITH CHECK (%s)', item->>'check') ELSE '' END
    );
  END LOOP;

  IF rls THEN
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', parent_schema, parent_name);
  END IF;
  IF force_rls THEN
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', parent_schema, parent_name);
  END IF;

  IF replica = 'f' THEN
    EXECUTE format('ALTER TABLE %I.%I REPLICA IDENTITY FULL', parent_schema, parent_name);
  ELSIF replica = 'n' THEN
    EXECUTE format('ALTER TABLE %I.%I REPLICA IDENTITY NOTHING', parent_schema, parent_name);
  ELSIF replica = 'i' AND replica_index IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I REPLICA IDENTITY USING INDEX %I', parent_schema, parent_name, replica_index);
  END IF;

  IF rel_options IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I SET (%s)', parent_schema, parent_name, array_to_string(rel_options, ', '));
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(grants_json) AS t(value)
  LOOP
    IF (item->>'privilege') NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN') THEN
      CONTINUE;
    END IF;
    IF (item->>'grantee')::oid = 0 THEN
      match_name := 'PUBLIC';
    ELSE
      SELECT r.rolname INTO match_name FROM pg_roles r WHERE r.oid = (item->>'grantee')::oid;
      IF match_name IS NULL THEN
        CONTINUE;
      END IF;
      match_name := format('%I', match_name);
    END IF;
    EXECUTE format(
      'GRANT %s ON TABLE %I.%I TO %s%s',
      item->>'privilege',
      parent_schema,
      parent_name,
      match_name,
      CASE WHEN (item->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END
    );
    match_name := NULL;
  END LOOP;

  IF owner_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', parent_schema, parent_name, owner_name);
  END IF;
  IF table_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON TABLE %I.%I IS %L', parent_schema, parent_name, table_comment);
  END IF;
END
`;
}

function partitionBody(partition: PartitionSnapshot, mode: "create" | "attach"): string {
  return `
DECLARE
  child_schema text := ${quoteLiteral(partition.schema)};
  child_name text := ${quoteLiteral(partition.name)};
  parent_schema text := ${quoteLiteral(partition.parentSchema)};
  parent_name text := ${quoteLiteral(partition.parentName)};
  bound_sql text := ${quoteLiteral(partition.boundSql)};
  child_oid oid;
  parent_oid oid;
  attached boolean;
BEGIN
  parent_oid := to_regclass(format('%I.%I', parent_schema, parent_name));
  child_oid := to_regclass(format('%I.%I', child_schema, child_name));
  IF parent_oid IS NULL THEN
    RAISE EXCEPTION 'drizzle-pg-extras: parent %.% does not exist. Partition the parent before attaching partitions.', parent_schema, parent_name;
  END IF;
  IF child_oid IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = child_oid AND inhparent = parent_oid) INTO attached;
    IF attached THEN
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = child_oid) THEN
      RAISE EXCEPTION 'drizzle-pg-extras: %.% is already a partition of another table.', child_schema, child_name;
    END IF;
    ${
      mode === "create"
        ? `RAISE EXCEPTION 'drizzle-pg-extras: %.% already exists and is not a partition of %.%.', child_schema, child_name, parent_schema, parent_name;`
        : `EXECUTE format('ALTER TABLE %I.%I ATTACH PARTITION %I.%I %s', parent_schema, parent_name, child_schema, child_name, bound_sql); RETURN;`
    }
  END IF;
  ${
    mode === "create"
      ? `EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I %s', child_schema, child_name, parent_schema, parent_name, bound_sql);`
      : `RAISE EXCEPTION 'drizzle-pg-extras: %.% does not exist. Create it with drizzle-kit before attaching it.', child_schema, child_name;`
  }
END
`;
}

function detachBody(partition: Pick<PartitionSnapshot, "schema" | "name" | "parentSchema" | "parentName">): string {
  return `
DECLARE
  child_schema text := ${quoteLiteral(partition.schema)};
  child_name text := ${quoteLiteral(partition.name)};
  parent_schema text := ${quoteLiteral(partition.parentSchema)};
  parent_name text := ${quoteLiteral(partition.parentName)};
  child_oid oid;
  parent_oid oid;
BEGIN
  parent_oid := to_regclass(format('%I.%I', parent_schema, parent_name));
  child_oid := to_regclass(format('%I.%I', child_schema, child_name));
  IF parent_oid IS NULL OR child_oid IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = child_oid AND inhparent = parent_oid) THEN
    EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I', parent_schema, parent_name, child_schema, child_name);
  END IF;
END
`;
}

function dropBody(partition: Pick<PartitionSnapshot, "schema" | "name" | "parentSchema" | "parentName">): string {
  return `
DECLARE
  child_schema text := ${quoteLiteral(partition.schema)};
  child_name text := ${quoteLiteral(partition.name)};
  parent_schema text := ${quoteLiteral(partition.parentSchema)};
  parent_name text := ${quoteLiteral(partition.parentName)};
  child_oid oid;
  parent_oid oid;
  non_empty boolean;
BEGIN
  parent_oid := to_regclass(format('%I.%I', parent_schema, parent_name));
  child_oid := to_regclass(format('%I.%I', child_schema, child_name));
  IF child_oid IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = child_oid AND (parent_oid IS NULL OR i.inhparent <> parent_oid)) THEN
    RAISE EXCEPTION 'drizzle-pg-extras: %.% is a partition of a different table. Refusing to drop it.', child_schema, child_name;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)', child_schema, child_name) INTO non_empty;
  IF non_empty THEN
    RAISE EXCEPTION 'drizzle-pg-extras: partition %.% has rows. Refusing to drop it. Empty it, or set onRemove: "detach" on the partition before removing it.', child_schema, child_name;
  END IF;
  IF parent_oid IS NOT NULL AND EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = child_oid AND inhparent = parent_oid) THEN
    EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I', parent_schema, parent_name, child_schema, child_name);
  END IF;
  EXECUTE format('DROP TABLE %I.%I', child_schema, child_name);
END
`;
}

function wrapDo(body: string): string {
  let tag = "pg_extras";
  let n = 0;
  while (body.includes(`$${tag}$`)) {
    n += 1;
    tag = `pg_extras${n}`;
  }
  return `DO $${tag}$${body.trim()}\n$${tag}$;`;
}

function swapName(name: string): string {
  const suffix = "__pgx";
  const max = 63 - Buffer.byteLength(suffix);
  let bytes = Buffer.from(name);
  if (bytes.length > max) bytes = bytes.subarray(0, max);
  while (bytes.length > 0 && (bytes[bytes.length - 1]! & 0xc0) === 0x80) {
    bytes = bytes.subarray(0, bytes.length - 1);
  }
  return bytes.toString() + suffix;
}

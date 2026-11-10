import { sql } from "drizzle-orm";
import { integer, pgMaterializedView, pgSchema, pgTable, pgView, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  defineExtras,
  diffSnapshots,
  parseSnapshot,
  pgFunction,
  pgTrigger,
  renderIdempotent,
  snapshotExtras,
  withComment,
  type TriggerSnapshot,
} from "../../src/index.js";

const auth = pgSchema("auth");

function touchFn() {
  return pgFunction("touch", { returns: "trigger", body: "BEGIN RETURN NEW; END;" });
}

function usersTable() {
  return pgTable("users", {
    id: integer("id").primaryKey(),
    email: text("email").notNull(),
    note: text("note"),
  });
}

describe("trigger sql", () => {
  it("emits a deferrable constraint trigger with FROM, and replaces it by drop plus create", () => {
    const customers = auth.table("customers", { id: integer("id").primaryKey() });
    const accounts = auth.table("accounts", {
      id: integer("id").primaryKey(),
      amount: integer("amount").notNull(),
    });
    const fn = pgFunction("reject_negative", {
      schema: "auth",
      returns: "trigger",
      body: "BEGIN IF NEW.amount < 0 THEN RAISE EXCEPTION 'negative'; END IF; RETURN NEW; END;",
    });
    const before = withComment(pgTrigger("accounts_amount", {
      table: accounts,
      timing: "after",
      events: ["update", "insert"],
      columns: [accounts.amount],
      constraint: { deferrable: true, initially: "immediate", from: customers },
      when: ({ NEW }) => sql`${NEW.amount} IS NOT NULL`,
      function: fn,
    }), "non-negative");
    const after = withComment(pgTrigger("accounts_amount", {
      table: accounts,
      timing: "after",
      events: ["insert", "update"],
      columns: [accounts.amount],
      constraint: { deferrable: true, initially: "deferred", from: customers },
      when: ({ NEW }) => sql`${NEW.amount} IS NOT NULL`,
      function: fn,
    }), "non-negative");
    const up = diffSnapshots(
      snapshotExtras(defineExtras({ functions: [fn], triggers: [before], tables: [accounts, customers] })),
      snapshotExtras(defineExtras({ functions: [fn], triggers: [after], tables: [accounts, customers] })),
    ).up;
    expect(up.map((statement) => statement.split("\n")[0])).toEqual([
      'DROP TRIGGER IF EXISTS "accounts_amount" ON "auth"."accounts";',
      'CREATE CONSTRAINT TRIGGER "accounts_amount"',
      'COMMENT ON TRIGGER "accounts_amount" ON "auth"."accounts" IS \'non-negative\';',
    ]);
    expect(up[1]).toContain('AFTER INSERT OR UPDATE OF "amount" ON "auth"."accounts"');
    expect(up[1]).toContain('FROM "auth"."customers"');
    expect(up[1]).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(up[1]).toContain("FOR EACH ROW");
    expect(up[1]).toContain('WHEN (NEW."amount" IS NOT NULL)');
    expect(up[1]).not.toContain("OR REPLACE");

    const first = diffSnapshots(
      snapshotExtras(defineExtras({ tables: [accounts] })),
      snapshotExtras(defineExtras({ functions: [fn], triggers: [before], tables: [accounts, customers] })),
    ).up;
    expect(first.some((statement) => statement.startsWith('DROP TRIGGER IF EXISTS "accounts_amount"'))).toBe(true);
    expect(first.some((statement) => statement.includes("NOT DEFERRABLE") || statement.includes("DEFERRABLE INITIALLY IMMEDIATE"))).toBe(true);
    const down = diffSnapshots(
      snapshotExtras(defineExtras({ functions: [fn], triggers: [before], tables: [accounts, customers] })),
      snapshotExtras(defineExtras({ functions: [fn], triggers: [after], tables: [accounts, customers] })),
    ).down;
    expect(down.join("\n")).toContain("DEFERRABLE INITIALLY IMMEDIATE");
    expect(down.join("\n")).toContain('COMMENT ON TRIGGER "accounts_amount"');
  });

  it("emits transition tables for statement and row triggers", () => {
    const ledger = pgTable("ledger", { id: integer("id").primaryKey(), amount: integer("amount") });
    const fn = touchFn();
    const inserted = pgTrigger("ledger_inserted", {
      table: ledger,
      timing: "after",
      events: ["insert"],
      forEach: "statement",
      referencing: { newTable: "inserted" },
      function: fn,
    });
    const updated = pgTrigger("ledger_updated", {
      table: ledger,
      timing: "after",
      events: ["update"],
      forEach: "row",
      referencing: { oldTable: "old_rows", newTable: "new_rows" },
      function: fn,
    });
    const up = diffSnapshots(
      snapshotExtras(defineExtras({})),
      snapshotExtras(defineExtras({ functions: [fn], triggers: [inserted, updated], tables: [ledger] })),
    ).up.join("\n");
    expect(up).toContain('AFTER INSERT ON "public"."ledger"\nREFERENCING NEW TABLE AS "inserted"\nFOR EACH STATEMENT');
    expect(up).toContain(
      'AFTER UPDATE ON "public"."ledger"\nREFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"\nFOR EACH ROW',
    );
  });

  it("emits INSTEAD OF on a view and statement UPDATE OF, and disables a table trigger", () => {
    const profiles = pgTable("profiles", { id: integer("id").primaryKey(), email: text("email").notNull() });
    const emails = pgView("profile_emails", { id: integer("id"), email: text("email") }).as(sql`select id, email from profiles`);
    const fn = touchFn();
    const instead = pgTrigger("profile_emails_insert", {
      table: emails,
      timing: "instead of",
      events: ["insert"],
      function: fn,
    });
    const statement = pgTrigger("profile_emails_update", {
      table: emails,
      timing: "before",
      events: ["update"],
      forEach: "statement",
      columns: [emails.email],
      when: sql`true`,
      function: fn,
    });
    const disabled = pgTrigger("profiles_guard", {
      table: profiles,
      timing: "before",
      events: ["delete"],
      function: fn,
      enabled: false,
    });
    const up = diffSnapshots(
      snapshotExtras(defineExtras({})),
      snapshotExtras(defineExtras({ functions: [fn], triggers: [instead, statement, disabled], tables: [profiles], views: [emails] })),
    ).up.join("\n");
    expect(up).toContain('INSTEAD OF INSERT ON "public"."profile_emails"\nFOR EACH ROW');
    expect(up).toContain('BEFORE UPDATE OF "email" ON "public"."profile_emails"\nFOR EACH STATEMENT\nWHEN (true)');
    expect(up).toContain('ALTER TABLE "public"."profiles" DISABLE TRIGGER "profiles_guard";');
  });

  it("enables with ALTER TABLE and disables again after CREATE OR REPLACE", () => {
    const users = usersTable();
    const fn = touchFn();
    const enabled = (on: boolean, when = "true") => pgTrigger("users_guard", {
      table: users,
      timing: "before",
      events: ["update"],
      when: sql.raw(when),
      function: fn,
      enabled: on,
    });
    const extras = (trigger: ReturnType<typeof enabled>) =>
      snapshotExtras(defineExtras({ functions: [fn], triggers: [trigger], tables: [users] }));
    expect(diffSnapshots(extras(enabled(true)), extras(enabled(false))).up).toEqual([
      'ALTER TABLE "public"."users" DISABLE TRIGGER "users_guard";',
    ]);
    expect(diffSnapshots(extras(enabled(false)), extras(enabled(true))).up).toEqual([
      'ALTER TABLE "public"."users" ENABLE TRIGGER "users_guard";',
    ]);
    const stayedOff = diffSnapshots(extras(enabled(false, "true")), extras(enabled(false, "false"))).up;
    expect(stayedOff.some((statement) => statement.startsWith("DROP TRIGGER"))).toBe(false);
    expect(stayedOff.some((statement) => statement.startsWith("CREATE OR REPLACE TRIGGER"))).toBe(true);
    expect(stayedOff.at(-1)).toBe('ALTER TABLE "public"."users" DISABLE TRIGGER "users_guard";');
    const turnedOn = diffSnapshots(extras(enabled(false, "true")), extras(enabled(true, "false"))).up;
    expect(turnedOn.some((statement) => statement.includes("ENABLE TRIGGER") || statement.includes("DISABLE TRIGGER"))).toBe(false);
  });

  it("keeps a v0.3 trigger snapshot and its comment stable", () => {
    const users = usersTable();
    const fn = touchFn();
    const trigger = withComment(pgTrigger("users_touch", {
      table: users,
      timing: "before",
      events: ["update"],
      columns: [users.email],
      when: sql`OLD.email IS DISTINCT FROM NEW.email`,
      function: fn,
    }), "keeps email");
    const current = snapshotExtras(defineExtras({ functions: [fn], triggers: [trigger], tables: [users] }));
    const raw = JSON.parse(JSON.stringify(current)) as typeof current;
    for (const stored of raw.triggers) {
      const legacy = stored as Partial<TriggerSnapshot>;
      delete legacy.constraint;
      delete legacy.deferrable;
      delete legacy.initially;
      delete legacy.fromSchema;
      delete legacy.fromTable;
      delete legacy.oldTable;
      delete legacy.newTable;
      delete legacy.enabled;
    }
    const parsed = parseSnapshot(raw);
    expect(diffSnapshots(parsed, current).up).toEqual([]);
    const removed = snapshotExtras(defineExtras({
      functions: [fn],
      triggers: [pgTrigger("users_touch", {
        table: users,
        timing: "before",
        events: ["update"],
        columns: [users.email],
        when: sql`OLD.email IS DISTINCT FROM NEW.email`,
        function: fn,
      })],
      tables: [users],
    }));
    expect(diffSnapshots(parsed, removed).up).toEqual([
      `COMMENT ON TRIGGER "users_touch" ON "public"."users" IS NULL;`,
    ]);
  });

  it("drops a constraint trigger before dropping a function whose signature changed", () => {
    const users = usersTable();
    const beforeFn = pgFunction("check_row", { returns: "trigger", body: "BEGIN RETURN NEW; END;" });
    const afterFn = pgFunction("check_row", {
      returns: "trigger",
      args: [{ name: "flag", type: "integer" }],
      body: "BEGIN RETURN NEW; END;",
    });
    const before = snapshotExtras(defineExtras({
      functions: [beforeFn],
      triggers: [pgTrigger("users_check", { table: users, timing: "after", events: ["insert"], constraint: true, function: beforeFn })],
      tables: [users],
    }));
    const after = snapshotExtras(defineExtras({
      functions: [afterFn],
      triggers: [pgTrigger("users_check", {
        table: users,
        timing: "after",
        events: ["insert"],
        constraint: true,
        function: afterFn,
        args: [1],
      })],
      tables: [users],
    }));
    const up = diffSnapshots(before, after).up;
    expect(up.map((statement) => statement.split("\n")[0])).toEqual([
      'DROP TRIGGER IF EXISTS "users_check" ON "public"."users";',
      'DROP FUNCTION IF EXISTS "public"."check_row"();',
      'CREATE OR REPLACE FUNCTION "public"."check_row"("flag" integer)',
      'CREATE CONSTRAINT TRIGGER "users_check"',
    ]);
    expect(up.filter((statement) => statement.startsWith("DROP TRIGGER"))).toHaveLength(1);
  });

  it("drops a constraint trigger before create in the idempotent script", () => {
    const users = usersTable();
    const fn = touchFn();
    const trigger = withComment(pgTrigger("users_check", {
      table: users,
      timing: "after",
      events: ["insert"],
      constraint: true,
      function: fn,
      enabled: false,
    }), "check");
    const script = renderIdempotent(defineExtras({ functions: [fn], triggers: [trigger], tables: [users] }));
    const dropAt = script.indexOf('DROP TRIGGER IF EXISTS "users_check"');
    const createAt = script.indexOf('CREATE CONSTRAINT TRIGGER "users_check"');
    const disableAt = script.indexOf('DISABLE TRIGGER "users_check"');
    const commentAt = script.indexOf('COMMENT ON TRIGGER "users_check"');
    expect(dropAt).toBeGreaterThan(-1);
    expect(dropAt).toBeLessThan(createAt);
    expect(createAt).toBeLessThan(disableAt);
    expect(disableAt).toBeLessThan(commentAt);
    expect(script).toContain("NOT DEFERRABLE");
  });
});

describe("trigger rules", () => {
  const users = usersTable();
  const fn = { name: "f" } as const;
  const base = {
    table: users,
    timing: "after" as const,
    events: ["update" as const],
    function: fn,
  };

  it("rejects constraint triggers that are not AFTER ROW on a table", () => {
    expect(() => pgTrigger("t", { ...base, timing: "before", constraint: true })).toThrow(/AFTER \.\.\. FOR EACH ROW/);
    expect(() => pgTrigger("t", { ...base, forEach: "statement", constraint: true })).toThrow(/AFTER \.\.\. FOR EACH ROW/);
    expect(() => pgTrigger("t", {
      ...base,
      constraint: { initially: "deferred" },
    })).toThrow(/INITIALLY DEFERRED requires DEFERRABLE/);
    const view = pgView("active", { id: integer("id") }).as(sql`select id from users`);
    expect(() => pgTrigger("t", {
      table: view,
      timing: "after",
      events: ["insert"],
      forEach: "statement",
      constraint: true,
      function: fn,
    })).toThrow(/AFTER \.\.\. FOR EACH ROW/);
    expect(() => pgTrigger("t", {
      ...base,
      constraint: { from: view as never },
    })).toThrow(/FROM must reference a table/);
  });

  it("rejects transition tables outside the Postgres rules", () => {
    expect(() => pgTrigger("t", { ...base, timing: "before", referencing: { oldTable: "old_rows" } })).toThrow(
      /only allowed on AFTER/,
    );
    expect(() => pgTrigger("t", {
      ...base,
      events: ["insert", "update"],
      referencing: { newTable: "new_rows" },
    })).toThrow(/more than one event/);
    expect(() => pgTrigger("t", {
      ...base,
      columns: [users.email],
      referencing: { newTable: "new_rows" },
    })).toThrow(/UPDATE OF/);
    expect(() => pgTrigger("t", {
      ...base,
      constraint: true,
      referencing: { newTable: "new_rows" },
    })).toThrow(/constraint triggers cannot use transition tables/);
    expect(() => pgTrigger("t", { ...base, events: ["insert"], referencing: { oldTable: "old_rows" } })).toThrow(
      /OLD TABLE is only allowed for UPDATE or DELETE/,
    );
    expect(() => pgTrigger("t", { ...base, events: ["delete"], referencing: { newTable: "new_rows" } })).toThrow(
      /NEW TABLE is only allowed for INSERT or UPDATE/,
    );
    expect(() => pgTrigger("t", {
      ...base,
      referencing: { oldTable: "rows", newTable: "rows" },
    })).toThrow(/different names/);
    expect(() => pgTrigger("t", {
      ...base,
      events: ["truncate"],
      forEach: "statement",
      referencing: { oldTable: "old_rows" },
    })).toThrow(/TRUNCATE/);
    const view = pgView("active", { email: text("email") }).as(sql`select email from users`);
    expect(() => pgTrigger("t", {
      table: view,
      timing: "after",
      events: ["insert"],
      forEach: "statement",
      referencing: { newTable: "inserted" },
      function: fn,
    })).toThrow(/only allowed on tables/);
  });

  it("rejects WHEN, UPDATE OF, and DISABLE TRIGGER where Postgres rejects them", () => {
    expect(() => pgTrigger("t", { ...base, events: ["insert"], when: sql`OLD.email IS NULL` })).toThrow(/cannot reference OLD/);
    expect(() => pgTrigger("t", { ...base, events: ["delete"], when: sql`NEW.email IS NULL` })).toThrow(/cannot reference NEW/);
    expect(() => pgTrigger("t", {
      ...base,
      events: ["insert", "update"],
      when: ({ OLD }) => sql`${OLD.email} IS NULL`,
    })).toThrow(/cannot reference OLD/);
    expect(() => pgTrigger("t", {
      ...base,
      forEach: "statement",
      when: sql`OLD.email IS NULL`,
    })).toThrow(/statement trigger WHEN/);
    expect(() => pgTrigger("t", { ...base, when: sql`EXISTS (SELECT 1)` })).toThrow(/subquery/);
    expect(() => pgTrigger("t", { ...base, when: sql`'SELECT' = 'SELECT'` })).not.toThrow();
    expect(() => pgTrigger("t", { ...base, when: sql.raw("$q$SELECT 1$q$ = 'x'") })).not.toThrow();
    const view = pgView("active", { id: integer("id"), email: text("email") }).as(sql`select id, email from users`);
    expect(() => pgTrigger("t", {
      table: view,
      timing: "instead of",
      events: ["update"],
      when: sql`true`,
      function: fn,
    })).toThrow(/do not support WHEN/);
    expect(() => pgTrigger("t", {
      table: view,
      timing: "instead of",
      events: ["update"],
      columns: [view.email],
      function: fn,
    })).toThrow(/column lists/);
    expect(() => pgTrigger("t", {
      table: view,
      timing: "before",
      events: ["update"],
      function: fn,
    })).toThrow(/forEach: "statement"/);
    expect(() => pgTrigger("t", {
      table: view,
      timing: "instead of",
      events: ["insert"],
      function: fn,
      enabled: false,
    })).toThrow(/DISABLE TRIGGER on a view/);
    const matview = pgMaterializedView("stats", { id: integer("id") }).as(sql`select id from users`);
    expect(() => pgTrigger("t", {
      table: matview,
      timing: "after",
      events: ["insert"],
      forEach: "statement",
      function: fn,
    })).toThrow(/materialized views/);
    const other = pgView("other", { email: text("email") }).as(sql`select email from users`);
    expect(() => pgTrigger("t", {
      table: view,
      timing: "before",
      events: ["update"],
      forEach: "statement",
      columns: [other.email] as never,
      function: fn,
    })).toThrow(/does not belong to view/);
  });
});

/**
 * Turn DuckDB's pushed-down WHERE predicates into Nango query parameters.
 *
 * Every function here sets `autoApplyFilters: true`, so the SDK re-applies every
 * pushed predicate to each batch exactly. Translation therefore only has to NARROW
 * the upstream request without ever dropping a matching row: predicates we cannot
 * express are simply not sent. Only top-level conjuncts are translated (a predicate
 * under OR/NOT is left to the SDK), so what is sent is always implied by the filter.
 */

import type { PushdownFilters } from "@query-farm/vgi";

type Expr = PushdownFilters["filters"][number];

/** One translatable constraint on a column. */
export type Constraint =
  | { kind: "cmp"; column: string; op: "eq" | "gt" | "ge" | "lt" | "le"; value: unknown }
  | { kind: "in"; column: string; values: unknown[] };

const FLIP: Record<string, "eq" | "gt" | "ge" | "lt" | "le"> = { eq: "eq", gt: "lt", ge: "le", lt: "gt", le: "ge" };

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

function one(e: Expr, out: Constraint[]): void {
  if (e.node === "and") {
    for (const c of e.children) one(c, out);
    return;
  }
  if (e.node === "comparison" && e.op in FLIP) {
    const [l, r] = [unwrap(e.left), unwrap(e.right)];
    if (l.node === "column_ref" && r.node === "literal" && r.value != null) {
      out.push({ kind: "cmp", column: l.columnName, op: e.op as "eq", value: r.value });
    } else if (r.node === "column_ref" && l.node === "literal" && l.value != null) {
      out.push({ kind: "cmp", column: r.columnName, op: FLIP[e.op] ?? "eq", value: l.value });
    }
    return;
  }
  if (e.node === "in" && !e.negated && e.set.kind === "literal") {
    const col = unwrap(e.expression);
    const values = e.set.values.filter((v) => v != null);
    if (col.node === "column_ref" && values.length > 0 && values.length === e.set.values.length) {
      out.push({ kind: "in", column: col.columnName, values });
    }
  }
}

/** The top-level, translatable constraints of a scan's pushed filters. */
export function constraintsOf(filters: PushdownFilters | undefined): Constraint[] {
  const out: Constraint[] = [];
  for (const f of filters?.filters ?? []) one(f, out);
  return out;
}

/** Every column name a pushed filter mentions anywhere (including under OR / NOT). */
export function referencedColumns(filters: PushdownFilters | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.node === "column_ref" && typeof o.columnName === "string") out.add(o.columnName);
      for (const x of Object.values(o)) if (x && typeof x === "object") walk(x);
    }
  };
  walk(filters?.filters ?? []);
  return out;
}

/** A pushed literal for a TIMESTAMPTZ column as epoch milliseconds (µs bigint, ms number, Date, ISO). */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v / 1000n);
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** The tightest lower bound (epoch ms) the constraints put on a time column, with its strictness. */
export function lowerBoundMs(constraints: Constraint[], column: string): number | undefined {
  let lower: number | undefined;
  for (const c of constraints) {
    if (c.column !== column || c.kind !== "cmp") continue;
    if (c.op !== "gt" && c.op !== "ge" && c.op !== "eq") continue;
    const ms = toEpochMs(c.value);
    if (ms === undefined) continue;
    lower = lower === undefined ? ms : Math.max(lower, ms);
  }
  return lower;
}

/** Equality / IN values pushed for a column (as strings), or undefined if unconstrained. */
export function eqValues(constraints: Constraint[], column: string): string[] | undefined {
  let set: string[] | undefined;
  for (const c of constraints) {
    if (c.column !== column) continue;
    let vs: string[] | undefined;
    if (c.kind === "cmp" && c.op === "eq" && (typeof c.value === "string" || typeof c.value === "number")) {
      vs = [String(c.value)];
    } else if (c.kind === "in" && c.values.every((v) => typeof v === "string" || typeof v === "number")) {
      vs = c.values.map(String);
    }
    if (!vs) continue;
    set = set ? set.filter((v) => vs.includes(v)) : [...new Set(vs)];
  }
  return set;
}

/**
 * One factory for every Nango listing.
 *
 * A spec names its columns (with a JSON extractor each) and a `page` function that
 * reads one page given an opaque cursor string. The factory turns that into a VGI
 * table function that:
 *
 * - streams one Nango page per Arrow batch (empty pages are skipped);
 * - keeps the cursor in serializable state, so a scan resumes on any process over
 *   HTTP and survives rate-limit pauses;
 * - reads the `nango` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int32,
  int64,
  list,
  schema,
  struct,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
  type VgiSchema,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, type NangoConfig, SECRET_TYPE } from "./client.ts";
import { type Constraint, constraintsOf, referencedColumns } from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

// biome-ignore lint/suspicious/noExplicitAny: Nango JSON is untyped.
export type Row = Record<string, any>;

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable?: boolean;
  get: (row: Row) => unknown;
}

/** Walk a dotted path (`a.b.0.c`) or JSON pointer (`/a/b/0/c`) through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  if (path === "" || path === "/") return row;
  const parts = path.startsWith("/")
    ? path
        .slice(1)
        .split("/")
        .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    : path.split(".");
  let cur: unknown = row;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
export const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
export const asBigInt = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d{1,18}$/.test(v)) return BigInt(v);
  return null;
};
export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

/** ISO 8601 → TIMESTAMPTZ microseconds, keeping sub-millisecond digits (Nango sends µs). */
export function asTime(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  const m = v.match(ISO_RE);
  if (!m) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
  }
  const frac = (m[3] ?? "").padEnd(6, "0").slice(0, 6);
  const zone = m[4] ?? "Z";
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (Number.isNaN(ms)) return null;
  return BigInt(ms) * 1000n + BigInt(frac || "0");
}
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : null;
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

export const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

type Getter = string | ((r: Row) => unknown);
const pick = (path: Getter) => (r: Row) => (typeof path === "string" ? at(r, path) : path(r));

function mk(name: string, type: VgiDataType, sqlType: string, doc: string, get: (r: Row) => unknown, nullable = true) {
  return { name, type, sqlType, doc, get, nullable } satisfies Col;
}

export const C = {
  str: (name: string, doc: string, path: Getter, nullable = true) =>
    mk(name, utf8(), "VARCHAR", doc, (r) => asStr(pick(path)(r)), nullable),
  time: (name: string, doc: string, path: Getter) =>
    mk(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asTime(pick(path)(r))),
  bool: (name: string, doc: string, path: Getter) => mk(name, bool, "BOOLEAN", doc, (r) => asBool(pick(path)(r))),
  int: (name: string, doc: string, path: Getter) => mk(name, int32, "INTEGER", doc, (r) => asInt(pick(path)(r))),
  bigint: (name: string, doc: string, path: Getter) => mk(name, int64(), "BIGINT", doc, (r) => asBigInt(pick(path)(r))),
  num: (name: string, doc: string, path: Getter) => mk(name, float64(), "DOUBLE", doc, (r) => asNum(pick(path)(r))),
  strList: (name: string, doc: string, path: Getter) =>
    mk(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(pick(path)(r))),
  json: (name: string, doc: string, path: Getter) => mk(name, utf8(), "JSON", doc, (r) => asJson(pick(path)(r))),
  structList: (name: string, doc: string, sqlType: string, fields: string[], path: Getter) =>
    mk(name, list(struct(fields.map((f) => field(f, utf8())) as never)), sqlType, doc, (r) => {
      const v = pick(path)(r);
      if (!Array.isArray(v)) return null;
      return v.map((item) => Object.fromEntries(fields.map((f) => [f, asStr(at(item, f))])));
    }),
};

/** The Arrow schema of a column list (column comments ride along as field metadata). */
export function schemaOf(columns: Col[]): VgiSchema {
  return schema(
    columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable ?? true, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable ?? true),
    ),
  );
}

/** Emit rows as one batch of the scan's full bound schema (the SDK filters, then projects). */
export function rowsToBatch(columns: Col[], rows: Row[], full: VgiSchema) {
  const cols: Record<string, unknown[]> = {};
  for (const f of full.fields) {
    const c = columns.find((x) => x.name === f.name);
    cols[f.name] = c ? rows.map((r) => c.get(r)) : rows.map(() => null);
  }
  return batchFromColumns(cols, full);
}

// --------------------------------------------------------------------- the factory

export interface ScanContext<A> {
  args: A;
  constraints: Constraint[];
  /** Columns DuckDB asked for, plus every column any pushed filter mentions. */
  needed: Set<string>;
}

export interface FnExample {
  sql: string;
  description: string;
}

export interface Page {
  rows: Row[];
  /** Opaque cursor for the next page; null when the listing is done. */
  next: string | null;
}

export interface NangoTableSpec<A> {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  args?: Record<string, VgiDataType>;
  argDocs?: Record<string, string>;
  argDefaults?: Record<string, unknown>;
  argConstraints?: Record<string, Record<string, unknown>>;
  columns: Col[];
  /** Read one page. `cursor` is "" for the first page, then whatever `next` was. */
  page: (cfg: NangoConfig, scan: ScanContext<A>, cursor: string) => Promise<Page>;
  /** Text appended to doc_md describing what pushes down. */
  pushdown?: string;
  /** Primary-key columns of a catalog table (each is declared NOT NULL too). */
  key?: string[];
  /** Single-column foreign keys to another catalog table's primary key. */
  foreignKeys?: { column: string; table: string; refColumn: string }[];
  examples: FnExample[];
}

interface ScanState {
  cursor: string;
  done: boolean;
}

/** Discovery tags shared by a spec's function or table. */
function tagsOf<A>(spec: NangoTableSpec<A>): Record<string, string> {
  return {
    domain: "integrations",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: spec.docMd + (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : ""),
    }),
    "vgi.result_columns_schema": JSON.stringify(
      spec.columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  };
}

/** A spec with no arguments exposed as a catalog table (`SELECT … FROM nango.main.integrations`). */
export function defineNangoCatalogTable(spec: NangoTableSpec<Record<string, never>>): TableDescriptor {
  const fn = defineNangoTable({ ...spec, name: `${spec.name}_scan` });
  const base = {
    schemaPath: ["main"],
    table: spec.name,
    enforcement: "ENFORCED" as const,
    validation: "ALL_ROWS" as const,
  };
  const constraints = [
    ...(spec.key ?? []).map((k) =>
      constraintRecord({ ...base, id: `${k}_not_null`, kind: "NOT_NULL", columns: [[k]] }),
    ),
    ...(spec.key?.length
      ? [constraintRecord({ ...base, id: "pk", kind: "PRIMARY_KEY", columns: spec.key.map((k) => [k]) })]
      : []),
    ...(spec.foreignKeys ?? []).map((fk) =>
      constraintRecord({
        ...base,
        id: `fk_${fk.column}`,
        kind: "FOREIGN_KEY",
        columns: [[fk.column]],
        references: { schemaPath: ["main"], table: fk.table, columns: [[fk.refColumn]], constraintId: "pk" },
      }),
    ),
  ];
  return {
    name: spec.name,
    comment: spec.description,
    columns: schemaOf(spec.columns),
    function: fn,
    constraints,
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

export function defineNangoTable<A extends Record<string, unknown>>(spec: NangoTableSpec<A>): VgiFunction {
  const outSchema = schemaOf(spec.columns);
  return defineTableFunction<A, ScanState>({
    name: spec.name,
    description: spec.description,
    args: spec.args ?? {},
    argDocs: spec.argDocs,
    argDefaults: spec.argDefaults,
    argConstraints: spec.argConstraints as never,
    filterPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Nango returns.
    autoApplyFilters: true,
    // Lets a scan skip per-row detail calls for columns nobody asked for.
    projectionPushdown: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({ cursor: "", done: false }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const needed = new Set(params.outputSchema.fields.map((f) => f.name));
      for (const c of referencedColumns(params.pushdownFilters)) needed.add(c);
      const scan: ScanContext<A> = { args: params.args, constraints: constraintsOf(params.pushdownFilters), needed };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
      // Loop until a page yields rows or the listing ends, so no empty batches go out.
      for (;;) {
        if (state.done) {
          out.finish();
          return;
        }
        const page = await spec.page(cfg, scan, state.cursor);
        state.cursor = page.next ?? "";
        state.done = page.next === null;
        if (page.rows.length) {
          out.emit(rowsToBatch(spec.columns, page.rows, outSchema));
          return;
        }
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
}

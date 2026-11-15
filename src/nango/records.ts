/**
 * `records(integration, connection_id, model, …)` — the records a Nango sync stored.
 *
 * Columns are typed from the model's JSON Schema when the deployed sync carries one
 * (`json_schema.definitions[model]` in GET /scripts/config), read at bind time:
 * string → VARCHAR (date-time → TIMESTAMPTZ), integer → BIGINT, number → DOUBLE,
 * boolean → BOOLEAN, array of strings → VARCHAR[], anything else → JSON. Without a
 * schema the record is returned as `_record` JSON plus a hoisted `id`. Every row also
 * carries `_nango_metadata` as `_nango_*` columns.
 *
 * Paging uses Nango's `next_cursor`, kept in the scan state.
 */

import {
  bool,
  defineTableFunction,
  float64,
  formatPushedFilters,
  int64,
  list,
  secretOfType,
  timestampMicros,
  utf8,
  type VgiSchema,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { objectTags } from "../meta.ts";
import {
  configFromSecrets,
  type NangoConfig,
  NangoError,
  nangoGet,
  nangoRequest,
  type Query,
  SECRET_TYPE,
} from "./client.ts";
import { constraintsOf, eqValues, lowerBoundMs, toEpochMs } from "./pushdown.ts";
import { scriptsOf } from "./resources.ts";
import {
  asBigInt,
  asBool,
  asJson,
  asNum,
  asStr,
  asStrList,
  asTime,
  C,
  type Col,
  type Row,
  rowsToBatch,
  schemaOf,
} from "./table.ts";

const Q = "nango.main";

/** Metadata columns every records() result ends with. */
export const META_COLUMNS: Col[] = [
  C.str("_nango_last_action", "Last change Nango saw: ADDED, UPDATED or DELETED.", "_nango_metadata.last_action"),
  C.time(
    "_nango_last_modified_at",
    "When Nango last detected a change to the record.",
    "_nango_metadata.last_modified_at",
  ),
  C.time("_nango_first_seen_at", "When Nango first saw the record.", "_nango_metadata.first_seen_at"),
  C.time(
    "_nango_deleted_at",
    "When Nango detected the record as deleted (NULL if not deleted).",
    "_nango_metadata.deleted_at",
  ),
  C.time("_nango_pruned_at", "When the record payload was pruned (emptied), or NULL.", "_nango_metadata.pruned_at"),
  C.str(
    "_nango_cursor",
    "The record's cursor (records after it can be read with Nango's cursor API).",
    "_nango_metadata.cursor",
  ),
  C.json("_record", "The full record payload (without _nango_metadata) as JSON.", (r) => {
    const { _nango_metadata: _m, ...rest } = r;
    return rest;
  }),
];

const RESERVED = new Set(META_COLUMNS.map((c) => c.name.toLowerCase()));

// biome-ignore lint/suspicious/noExplicitAny: JSON Schema is untyped.
type JsonSchema = Record<string, any>;

/** Strip `null` from a type union (`["string","null"]`, `anyOf: [{…}, {type: null}]`). */
function nonNull(s: JsonSchema): JsonSchema {
  if (Array.isArray(s.type)) {
    const t = s.type.filter((x: string) => x !== "null");
    return t.length === 1 ? { ...s, type: t[0] } : s;
  }
  for (const k of ["anyOf", "oneOf"]) {
    if (Array.isArray(s[k])) {
      const alts = (s[k] as JsonSchema[]).filter((x) => x?.type !== "null");
      if (alts.length === 1 && alts[0]) return nonNull(alts[0]);
    }
  }
  return s;
}

/** One typed column for a model property. */
export function propertyColumn(name: string, prop: JsonSchema): Col {
  const s = nonNull(prop ?? {});
  const doc = typeof s.description === "string" && s.description ? s.description : `Model field ${name}.`;
  const get = (r: Row) => r[name];
  const mk = (type: Col["type"], sqlType: string, conv: (v: unknown) => unknown): Col => ({
    name,
    type,
    sqlType,
    doc,
    nullable: true,
    get: (r) => conv(get(r)),
  });
  switch (s.type) {
    case "string":
      return s.format === "date-time"
        ? mk(timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", asTime)
        : mk(utf8(), "VARCHAR", asStr);
    case "integer":
      return mk(int64(), "BIGINT", asBigInt);
    case "number":
      return mk(float64(), "DOUBLE", asNum);
    case "boolean":
      return mk(bool, "BOOLEAN", asBool);
    case "array":
      if (nonNull(s.items ?? {}).type === "string") return mk(list(utf8()), "VARCHAR[]", asStrList);
      return mk(utf8(), "JSON", (v) => (v === undefined ? null : asJson(v)));
    default:
      return mk(utf8(), "JSON", (v) => (v === undefined ? null : asJson(v)));
  }
}

/** Column list for a model: typed from its JSON Schema, else `id` + metadata + `_record`. */
export function modelColumns(def: JsonSchema | undefined): { columns: Col[]; typed: boolean } {
  const props = def && typeof def.properties === "object" ? (def.properties as Record<string, JsonSchema>) : undefined;
  if (!props || Object.keys(props).length === 0) {
    return {
      columns: [C.str("id", "Record id (hoisted from the payload; the rest is in _record).", "id"), ...META_COLUMNS],
      typed: false,
    };
  }
  const seen = new Set<string>();
  const cols: Col[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const lower = name.toLowerCase();
    // DuckDB column names are case-insensitive; reserved names stay inside _record.
    if (seen.has(lower) || RESERVED.has(lower) || lower.startsWith("_nango_")) continue;
    seen.add(lower);
    cols.push(propertyColumn(name, prop));
  }
  return { columns: [...cols, ...META_COLUMNS], typed: true };
}

/** Find `json_schema.definitions[model]` among the syncs deployed to `integration`. */
export function findModelSchema(config: unknown, integration: string, model: string): JsonSchema | undefined {
  for (const s of scriptsOf(config, "syncs")) {
    if (s.provider_config_key !== integration) continue;
    const def = s.json_schema?.definitions?.[model] ?? s.json_schema?.$defs?.[model];
    if (def && typeof def === "object") return def as JsonSchema;
  }
  return undefined;
}

/** Cache /scripts/config per host+key for a minute: bind runs it, and binds repeat. */
const configCache = new Map<string, { at: number; body: unknown }>();
async function scriptsConfig(cfg: NangoConfig): Promise<unknown> {
  const k = `${cfg.host}\u0000${cfg.secretKey}`;
  const hit = configCache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.body;
  const body = await nangoGet(cfg, "/scripts/config", [["format", "nango"]]);
  configCache.set(k, { at: Date.now(), body });
  return body;
}

const FILTER_PATTERN = "^(added|updated|deleted)(,(added|updated|deleted))*$";

interface RecordsArgs {
  integration: string;
  connection_id: string;
  model: string;
  modified_after: unknown;
  filter: string | null;
  variant: string | null;
  page_size: bigint;
}

/** A TIMESTAMPTZ argument as epoch ms: the SDK hands over raw microseconds (number or bigint). */
export function argTimeMs(v: unknown): number | undefined {
  if (typeof v === "number") return Math.floor(v / 1000);
  return toEpochMs(v);
}

/** Build the GET /records query from the arguments and the pushed constraints (narrowing only). */
export function recordsQuery(
  args: RecordsArgs,
  constraints: ReturnType<typeof constraintsOf>,
  cursor: string,
): Query | null {
  const q: Query = [
    ["model", args.model],
    ["limit", String(Number(args.page_size ?? 100))],
  ];
  if (args.variant) q.push(["variant", args.variant]);
  // modified_after: the later of the argument and a pushed lower bound on _nango_last_modified_at.
  // Nango's comparison is strict, so a pushed bound backs off 1 ms (the SDK re-applies it exactly).
  const argMs = args.modified_after == null ? undefined : argTimeMs(args.modified_after);
  if (args.modified_after != null && argMs === undefined) {
    throw new NangoError(`modified_after: cannot read ${String(args.modified_after)} as a timestamp`);
  }
  const pushed = lowerBoundMs(constraints, "_nango_last_modified_at");
  const after = Math.max(argMs ?? -Infinity, pushed === undefined ? -Infinity : pushed - 1);
  if (Number.isFinite(after)) q.push(["modified_after", new Date(after).toISOString()]);
  // filter: the argument, intersected with a pushed _nango_last_action = / IN.
  let actions = args.filter ? new Set(args.filter.split(",")) : undefined;
  const pushedActions = eqValues(constraints, "_nango_last_action");
  if (pushedActions) {
    const want = new Set(
      pushedActions.map((v) => v.toLowerCase()).filter((v) => ["added", "updated", "deleted"].includes(v)),
    );
    actions = actions ? new Set([...actions].filter((a) => want.has(a))) : want;
    if (actions.size === 0) return null;
  }
  if (actions && actions.size < 3) q.push(["filter", [...actions].sort().join(",")]);
  const ids = eqValues(constraints, "id");
  if (ids) {
    if (ids.length === 0) return null;
    if (ids.length <= 100) for (const id of ids) q.push(["ids", id]);
  }
  if (cursor) q.push(["cursor", cursor]);
  return q;
}

interface RecordsState {
  cursor: string;
  done: boolean;
}

export const records = defineTableFunction<RecordsArgs, RecordsState>({
  name: "records",
  description: "Records a Nango sync stored for one connection and model, typed from the model's JSON Schema",
  args: {
    integration: utf8(),
    connection_id: utf8(),
    model: utf8(),
    modified_after: timestampMicros("UTC"),
    filter: utf8(),
    variant: utf8(),
    page_size: int64(),
  },
  argDefaults: { modified_after: null, filter: null, variant: null, page_size: 100 },
  argDocs: {
    integration: "Integration id (provider_config_key), e.g. 'github-prod'.",
    connection_id: "Connection id whose records to read.",
    model: "Model name as listed in the models column of nango.main.syncs, e.g. 'GithubIssue'.",
    modified_after: "Only records Nango changed after this instant (named; also pushed from _nango_last_modified_at).",
    filter: "Only records whose last action is one of these: comma list of added, updated, deleted (named).",
    variant: "Sync variant to read (named; default the base variant).",
    page_size: "Records requested per page (named, 1 to 1000).",
  },
  argConstraints: { filter: { pattern: FILTER_PATTERN }, page_size: { ge: 1, le: 1000 } },
  filterPushdown: true,
  autoApplyFilters: true,
  onBind: async (params) => {
    if (!params.resolvedSecretsProvided) {
      return { outputSchema: schemaOf(modelColumns(undefined).columns), lookupSecretTypes: [SECRET_TYPE] };
    }
    // No nango secret: bind untyped (EXPLAIN / LIMIT 0 work); the scan then reports how to add one.
    if (!secretOfType(params.secrets as never, SECRET_TYPE)) {
      return { outputSchema: schemaOf(modelColumns(undefined).columns) };
    }
    const cfg = configFromSecrets(params.secrets);
    const { integration, model } = params.args;
    if (!integration || !model) throw new NangoError("records: integration and model are required");
    const def = findModelSchema(await scriptsConfig(cfg), integration, model);
    return { outputSchema: schemaOf(modelColumns(def).columns) };
  },
  initialState: () => ({ cursor: "", done: false }),
  process: async (params, state, out) => {
    const cfg = configFromSecrets(params.secrets);
    const full = params.initCall.output_schema as unknown as VgiSchema;
    // Rebuild the column getters for the bound schema (same JSON Schema → same columns).
    const def = findModelSchema(await scriptsConfig(cfg), params.args.integration, params.args.model);
    let { columns } = modelColumns(def);
    if (columns.length !== full.fields.length || columns.some((c, i) => c.name !== full.fields[i]?.name)) {
      // The schema changed between bind and scan (a redeploy): fall back to name lookups as JSON/strings.
      columns = full.fields.map(
        (f) => META_COLUMNS.find((m) => m.name === f.name) ?? propertyColumn(f.name, schemaKind(f)),
      );
    }
    const constraints = constraintsOf(params.pushdownFilters);
    log.debug(`records: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
    for (;;) {
      if (state.done) {
        out.finish();
        return;
      }
      const query = recordsQuery(params.args, constraints, state.cursor);
      if (!query) {
        state.done = true;
        continue;
      }
      const res = await nangoRequest(cfg, "/records", {
        query,
        headers: { "Connection-Id": params.args.connection_id, "Provider-Config-Key": params.args.integration },
      });
      const body = (res.body ?? {}) as Row;
      const rows = Array.isArray(body.records) ? (body.records as Row[]) : [];
      const next = typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : null;
      state.cursor = next ?? "";
      state.done = next === null || rows.length === 0;
      if (rows.length) {
        out.emit(rowsToBatch(columns, rows, full));
        return;
      }
    }
  },
  tags: {
    domain: "integrations",
    ...objectTags({
      title: "Nango Synced Records",
      category: "syncs",
      keywords: "nango, records, synced data, models, incremental, modified_after, deleted records, unified api",
      docLlm:
        "Read the records a Nango sync stored (GET /records) for one connection: " +
        "records(integration, connection_id, model, modified_after := NULL, filter := NULL, variant := NULL, " +
        "page_size := 100). Find integration/model pairs in nango.main.syncs (models column) and connection ids in " +
        "nango.main.connections(). When the deployed sync has a JSON Schema for the model, each model field is " +
        "its own typed column (date-time strings are `TIMESTAMPTZ`, integers `BIGINT`); otherwise you get `id` and the " +
        "payload as `_record` JSON (use _record->>'field'). Every row has _nango_last_action (ADDED/UPDATED/DELETED), " +
        "_nango_last_modified_at, _nango_first_seen_at, _nango_deleted_at, _nango_pruned_at, _nango_cursor and " +
        "_record. Deleted records are included (filter _nango_deleted_at IS NULL for live ones). For incremental " +
        "reads filter _nango_last_modified_at > <ts>: it becomes Nango's modified_after.",
      docMd:
        "## records(integration, connection_id, model, modified_after := NULL, filter := NULL, variant := NULL, page_size := 100)\n\n" +
        "Synced records for one connection and model. Columns come from the model's JSON Schema when the sync " +
        "has one; otherwise `id` + `_record` JSON.\n\n" +
        "**Pushdown:** `_nango_last_modified_at` > / >= → `modified_after`; `_nango_last_action` = / IN → " +
        "`filter`; `id` = / IN (≤ 100) → `ids`. Paging follows `next_cursor`.",
    }),
    "vgi.result_columns_schema": JSON.stringify(
      modelColumns(undefined).columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  },
  examples: [
    {
      sql: `SELECT _record->>'title' AS title, _nango_last_modified_at FROM ${Q}.records('github-prod', 'conn-ada-github', 'GithubIssue') WHERE _nango_deleted_at IS NULL AND _record->>'state' = 'open' ORDER BY title`,
      description: "Open GitHub issues a Nango sync stored (typed model columns such as state are also available)",
    },
    {
      sql: `SELECT id, _nango_last_action FROM ${Q}.records('github-prod', 'conn-ada-github', 'GithubIssue') WHERE _nango_last_modified_at > TIMESTAMPTZ '2026-11-01 00:00:00+00' ORDER BY id`,
      description: "Incremental read: records changed since a timestamp (pushed down as modified_after)",
    },
  ],
});

/** Best-effort JSON Schema for a bound Arrow field (schema-drift fallback). */
function schemaKind(f: { type: { toString(): string } }): JsonSchema {
  const t = f.type.toString().toLowerCase();
  if (t.includes("timestamp")) return { type: "string", format: "date-time" };
  if (t.includes("list")) return { type: "array", items: { type: "string" } };
  if (t.includes("int")) return { type: "integer" };
  if (t.includes("float") || t.includes("double")) return { type: "number" };
  if (t.includes("bool")) return { type: "boolean" };
  return { type: "string" };
}

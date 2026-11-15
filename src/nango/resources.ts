/**
 * Nango metadata as SQL: providers, integrations, connections, syncs, actions, sync
 * status and environment information.
 *
 * Secrets never reach a row: integrations are read without `include=credentials`,
 * connection credentials are reduced to their type and expiry before a row is
 * built, and environment variables expose names only.
 */

import { int64, utf8 } from "@query-farm/vgi";
import { type NangoConfig, NangoError, nangoGet, nangoRequest, type Query, seg } from "./client.ts";
import { eqValues } from "./pushdown.ts";
import { C, type Col, defineNangoCatalogTable, defineNangoTable, type Page, type Row } from "./table.ts";

const Q = "nango.main";

/** Unwrap `{data: [...]}` / `[...]` / `{<key>: [...]}` list bodies. */
export function listOf(body: unknown, key = "data"): Row[] {
  if (Array.isArray(body)) return body as Row[];
  if (body && typeof body === "object") {
    const v = (body as Row)[key];
    if (Array.isArray(v)) return v as Row[];
    if (v && typeof v === "object") return [v as Row];
  }
  return [];
}

/** GET an object by key; 404 → undefined. `wrapped`: the object is under `data`. */
async function getOne(cfg: NangoConfig, path: string, query: Query = [], wrapped = true): Promise<Row | undefined> {
  const res = await nangoRequest(cfg, path, { query, passStatuses: [404] });
  if (res.status === 404 || !res.body || typeof res.body !== "object") return undefined;
  return wrapped ? listOf(res.body)[0] : (res.body as Row);
}

const done = (rows: Row[]): Page => ({ rows, next: null });

// -------------------------------------------------------------------- providers

const providerColumns: Col[] = [
  C.str("name", "Provider name, the key used when creating an integration (e.g. 'github', 'hubspot').", "name", false),
  C.str("display_name", "Human-readable provider name.", "display_name"),
  C.str(
    "auth_mode",
    "How Nango authenticates: OAUTH1, OAUTH2, OAUTH2_CC, API_KEY, BASIC, APP, JWT, TBA, NONE, CUSTOM, …",
    "auth_mode",
  ),
  C.strList("categories", "Catalog categories, e.g. ['crm', 'marketing'].", "categories"),
  C.str("docs", "Nango's documentation page for this provider.", "docs"),
  C.str("proxy_base_url", "Base URL the Nango proxy prefixes to request paths for this provider.", "proxy.base_url"),
  C.json(
    "proxy_paginate",
    "The provider's default proxy pagination config (type cursor / link / offset and its field names), or NULL.",
    (r) => r.proxy?.paginate ?? null,
  ),
  C.strList("default_scopes", "OAuth scopes requested by default.", "default_scopes"),
  C.str("authorization_url", "OAuth authorization endpoint (OAuth providers).", "authorization_url"),
  C.str("token_url", "OAuth token endpoint (a string, or JSON for per-grant URLs).", "token_url"),
];

export const providers = defineNangoCatalogTable({
  name: "providers",
  key: ["name"],
  description: "Nango's provider catalog: every API Nango can authenticate to, with its auth mode and categories",
  title: "Nango Provider Catalog",
  category: "catalog",
  keywords: "nango, providers, catalog, apis, oauth, auth mode, unified api, integrations available",
  docLlm:
    "Nango's catalog of 400+ supported APIs (GET /providers), one row per provider: name (use it as the " +
    "provider when reading integrations), display_name, auth_mode (OAUTH2, API_KEY, BASIC, APP, …), " +
    "categories (`VARCHAR[]`; filter with list_contains(categories, 'crm')), docs URL, proxy_base_url and " +
    "the default proxy_paginate config the `proxy` function's paginate := 'provider' uses. " +
    "`WHERE name = 'x'` (or IN) reads only those providers.",
  docMd: "## providers\n\nNango's provider catalog: the APIs it can broker credentials for.",
  pushdown: "`name` = / IN → `GET /providers/{name}` per value instead of the whole catalog.",
  columns: providerColumns,
  page: async (cfg, scan) => {
    const names = eqValues(scan.constraints, "name");
    if (names && names.length <= 20) {
      const rows = await Promise.all(names.map((n) => getOne(cfg, `/providers/${seg(n)}`)));
      return done(rows.filter((r): r is Row => !!r));
    }
    return done(listOf(await nangoGet(cfg, "/providers")));
  },
  examples: [
    {
      sql: `SELECT auth_mode, count(*) AS providers FROM ${Q}.providers GROUP BY auth_mode ORDER BY providers DESC`,
      description: "How many catalog providers use each auth mode",
    },
    {
      sql: `SELECT name, display_name, auth_mode FROM ${Q}.providers WHERE list_contains(categories, 'crm') ORDER BY name`,
      description: "CRM providers Nango supports",
    },
  ],
});

// ----------------------------------------------------------------- integrations

export const integrations = defineNangoCatalogTable({
  name: "integrations",
  key: ["unique_key"],
  foreignKeys: [{ column: "provider", table: "providers", refColumn: "name" }],
  description: "Integrations configured in this Nango environment (provider configs; client secrets are never read)",
  title: "Nango Integrations",
  category: "catalog",
  keywords: "nango, integrations, provider config key, configured apis, oauth apps, unique key",
  docLlm:
    "The integrations configured in the Nango environment the secret key belongs to (GET /integrations): " +
    "unique_key (the integration id, a.k.a. provider_config_key, which every other function takes), " +
    "display_name, provider (joins providers.name), logo, created_at, updated_at, forward_webhooks, " +
    "missing_fields (credential fields still to be configured, names only) and is_configured. Developer-app " +
    "client ids and secrets are never requested.",
  docMd: "## integrations\n\nConfigured integrations (provider configs) in this Nango environment.",
  pushdown: "`unique_key` = / IN → `GET /integrations/{key}` per value.",
  columns: [
    C.str(
      "unique_key",
      "Integration id (provider_config_key) used by connections, syncs, records and proxy.",
      "unique_key",
      false,
    ),
    C.str("display_name", "Human-readable integration name shown in the Nango dashboard.", "display_name"),
    C.str("provider", "Provider name; joins nango.main.providers.name.", "provider"),
    C.str("logo", "Logo URL (SVG).", "logo"),
    C.time("created_at", "When the integration was created.", "created_at"),
    C.time("updated_at", "When the integration last changed.", "updated_at"),
    C.bool("forward_webhooks", "Whether provider webhooks are forwarded to your backend.", "forward_webhooks"),
    C.strList("missing_fields", "Credential fields still missing (names only, never values).", "missing_fields"),
    C.bool("is_configured", "True when no credential fields are missing.", (r) =>
      Array.isArray(r.missing_fields) ? r.missing_fields.length === 0 : null,
    ),
  ],
  page: async (cfg, scan) => {
    const keys = eqValues(scan.constraints, "unique_key");
    if (keys && keys.length <= 20) {
      const rows = await Promise.all(keys.map((k) => getOne(cfg, `/integrations/${seg(k)}`)));
      return done(rows.filter((r): r is Row => !!r));
    }
    return done(listOf(await nangoGet(cfg, "/integrations")));
  },
  examples: [
    {
      sql: `SELECT unique_key, provider, missing_fields FROM ${Q}.integrations WHERE NOT is_configured ORDER BY unique_key`,
      description: "Integrations whose developer-app credentials are incomplete",
    },
    {
      sql: `SELECT i.unique_key, p.auth_mode FROM ${Q}.integrations i JOIN ${Q}.providers p ON p.name = i.provider ORDER BY i.unique_key`,
      description: "Each integration with its provider's auth mode",
    },
  ],
});

// ------------------------------------------------------------------ connections

/** Columns that need the per-connection detail call (GET /connections/{id}). */
export const DETAIL_COLUMNS = ["credential_type", "credential_expires_at", "updated_at", "last_fetched_at"];

/**
 * Reduce a full connection (which carries live tokens) to the non-secret detail fields.
 * Nothing else from `credentials` survives this function.
 */
export function connectionDetail(full: Row | undefined): Row {
  const cred = full?.credentials as Row | undefined;
  const expires = cred && typeof cred.expires_at === "string" ? cred.expires_at : null;
  return {
    credential_type: cred && typeof cred.type === "string" ? cred.type : null,
    credential_expires_at: expires,
    updated_at: typeof full?.updated_at === "string" ? full.updated_at : null,
    last_fetched_at: typeof full?.last_fetched_at === "string" ? full.last_fetched_at : null,
  };
}

/** Parse the `tags :=` argument: a JSON object of string values. */
export function parseTags(raw: string | null | undefined): Record<string, string> {
  if (raw == null || raw.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new NangoError(`tags must be a JSON object such as '{"end_user_id": "u_1"}', got ${raw}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new NangoError("tags must be a JSON object");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") throw new NangoError(`tags.${k} must be a string`);
    out[k.toLowerCase()] = val;
  }
  return out;
}

const TAG_COLUMNS: Record<string, string> = {
  end_user_id: "end_user_id",
  end_user_email: "end_user_email",
  organization_id: "organization_id",
};

export const connections = defineNangoTable<{ tags: string | null; page_size: bigint }>({
  name: "connections",
  description:
    "Nango connections with end-user / organization tags, errors and credential type + expiry (never tokens)",
  title: "Nango Connections",
  category: "connections",
  keywords: "nango, connections, end users, organizations, tags, credentials, token expiry, auth errors, oauth",
  docLlm:
    "Every connection in the Nango environment (GET /connections), one row each: id, connection_id, " +
    "provider_config_key (the integration), provider, created, the end_user_id / end_user_email / " +
    "organization_id connection tags, all tags and metadata as JSON, the deprecated end_user object, errors " +
    "(`LIST` of `STRUCT`(type, log_id); type 'auth' = credentials invalid, 'sync' = last sync failed), " +
    "has_auth_error, and — only when you select or filter them — credential_type, credential_expires_at, " +
    "updated_at and last_fetched_at, which cost one GET /connections/{id} per row. Access and refresh tokens " +
    'are never returned. `tags := \'{"plan": "pro"}\'` filters on any tag server-side. ' +
    "Use the connection_id + provider_config_key pair with records() and proxy().",
  docMd:
    "## connections(tags := NULL, page_size := 100)\n\nNango connections. Credential details are reduced " +
    "to `credential_type` and `credential_expires_at`; tokens never leave the worker.",
  pushdown:
    "`connection_id` = → `connectionId`; `end_user_id`, `end_user_email`, `organization_id` = → " +
    "`tags[<name>]`; `tags :=` → `tags[<key>]`. Detail columns are fetched only when projected or filtered.",
  args: { tags: utf8(), page_size: int64() },
  argDefaults: { tags: null, page_size: 100 },
  argDocs: {
    tags: 'Optional JSON object of connection tags that must all match, e.g. \'{"organization_id": "org_1"}\'.',
    page_size: "Connections requested per page (1 to 1000).",
  },
  argConstraints: { page_size: { ge: 1, le: 1000 } },
  columns: [
    C.bigint("id", "Nango's internal numeric connection id.", "id"),
    C.str("connection_id", "The connection id (pass it to records() and proxy()).", "connection_id", false),
    C.str("provider_config_key", "Integration id (integrations.unique_key).", "provider_config_key", false),
    C.str("provider", "Provider name (providers.name).", "provider"),
    C.time("created", "When the connection was created.", "created"),
    C.str("end_user_id", "The end_user_id connection tag.", "tags.end_user_id"),
    C.str("end_user_email", "The end_user_email connection tag.", "tags.end_user_email"),
    C.str("organization_id", "The organization_id connection tag.", "tags.organization_id"),
    C.json("tags", "All connection tags (lowercase keys) as a JSON object.", (r) => r.tags ?? {}),
    C.json(
      "metadata",
      "Custom metadata attached to the connection, as JSON (NULL when none).",
      (r) => r.metadata ?? null,
    ),
    C.json(
      "end_user",
      "Deprecated end_user object (id, email, display_name, organization) when set.",
      (r) => r.end_user ?? null,
    ),
    C.structList(
      "errors",
      "Connection errors: type 'auth' (credentials invalid) or 'sync' (last sync failed), with the Nango log id.",
      "STRUCT(type VARCHAR, log_id VARCHAR)[]",
      ["type", "log_id"],
      "errors",
    ),
    C.bool("has_auth_error", "True when Nango reports the credentials invalid (an 'auth' error).", (r) =>
      Array.isArray(r.errors) ? r.errors.some((e: Row) => e?.type === "auth") : false,
    ),
    C.str(
      "credential_type",
      "Credential type, e.g. OAUTH2, API_KEY, BASIC, APP (detail call; never the token).",
      "credential_type",
    ),
    C.time(
      "credential_expires_at",
      "When the current access token expires (OAuth); NULL when it does not.",
      "credential_expires_at",
    ),
    C.time("updated_at", "When the connection last changed (detail call).", "updated_at"),
    C.time("last_fetched_at", "When credentials were last fetched through Nango (detail call).", "last_fetched_at"),
  ],
  page: async (cfg, scan, cursor) => {
    const page = cursor ? Number(cursor) : 0;
    const limit = Number(scan.args.page_size ?? 100);
    const query: Query = [
      ["limit", String(limit)],
      ["page", String(page)],
    ];
    const ids = eqValues(scan.constraints, "connection_id");
    if (ids?.length === 1) query.push(["connectionId", ids[0] as string]);
    const tags = parseTags(scan.args.tags);
    for (const [col, tag] of Object.entries(TAG_COLUMNS)) {
      const v = eqValues(scan.constraints, col);
      if (v?.length === 1) {
        if (tags[tag] !== undefined && tags[tag] !== v[0]) return done([]);
        tags[tag] = v[0] as string;
      } else if (v && v.length === 0) return done([]);
    }
    for (const [k, v] of Object.entries(tags)) query.push([`tags[${k}]`, v]);
    if (ids && ids.length === 0) return done([]);
    const rows = listOf(await nangoGet(cfg, "/connections", query), "connections");
    if (DETAIL_COLUMNS.some((c) => scan.needed.has(c))) {
      for (const r of rows) {
        const full = await getOne(
          cfg,
          `/connections/${seg(String(r.connection_id))}`,
          [
            ["provider_config_key", String(r.provider_config_key)],
            ["refresh_token", "false"],
          ],
          false,
        );
        Object.assign(r, connectionDetail(full));
      }
    }
    return { rows, next: rows.length < limit ? null : String(page + 1) };
  },
  examples: [
    {
      sql: `SELECT provider_config_key, count(*) AS connections, count(*) FILTER (WHERE has_auth_error) AS broken FROM ${Q}.connections() GROUP BY provider_config_key ORDER BY connections DESC`,
      description: "Connections and broken (auth-error) connections per integration",
    },
    {
      sql: `SELECT connection_id, provider, credential_type, credential_expires_at FROM ${Q}.connections() WHERE organization_id = 'org_acme' ORDER BY credential_expires_at`,
      description: "One organization's connections and when their tokens expire",
    },
  ],
});

// ------------------------------------------------------------- syncs & actions

/** Flatten `GET /scripts/config` (one entry per integration) into its syncs or actions. */
export function scriptsOf(body: unknown, kind: "syncs" | "actions"): Row[] {
  const out: Row[] = [];
  for (const integ of listOf(body)) {
    for (const s of (integ[kind] as Row[] | undefined) ?? []) {
      out.push({ ...s, provider_config_key: integ.providerConfigKey, provider: integ.provider });
    }
  }
  return out;
}

const scriptColumns = (kind: string): Col[] => [
  C.str("provider_config_key", "Integration id the function is deployed to.", "provider_config_key", false),
  C.str("provider", "Provider name.", "provider"),
  C.str("name", `${kind} name.`, "name", false),
  C.strList("models", "Model names it returns (pass one to records() as `model`).", "returns"),
  C.str("description", "Description from the function's definition.", "description"),
  C.str("version", "Deployed version.", "version"),
  C.time("last_deployed", "When it was last deployed.", "last_deployed"),
  C.bool("is_public", "True for a public (catalog) template.", "is_public"),
  C.bool("pre_built", "True for a Nango pre-built template.", "pre_built"),
  C.strList("scopes", "Provider scopes it needs.", "scopes"),
  C.json("endpoints", "Endpoints it exposes ({method, path, group}).", (r) => r.endpoints ?? null),
];

export const syncs = defineNangoCatalogTable({
  name: "syncs",
  key: ["provider_config_key", "name"],
  foreignKeys: [{ column: "provider_config_key", table: "integrations", refColumn: "unique_key" }],
  description: "Sync functions deployed in this Nango environment, with their models, schedule and JSON schema",
  title: "Nango Syncs",
  category: "syncs",
  keywords: "nango, syncs, models, schedule, frequency, sync scripts, data models, json schema",
  docLlm:
    "Every sync deployed to the environment (GET /scripts/config), one row per (provider_config_key, name): " +
    "models (`VARCHAR[]` of the model names records() reads), runs (schedule such as 'every hour'), enabled, " +
    "auto_start, track_deletes, version, last_deployed, scopes, endpoints, and json_schema (the models' JSON " +
    "Schema definitions, used by records() to type its columns; NULL when the sync was deployed without one). " +
    "Join nango.main.integrations ON integrations.unique_key = syncs.provider_config_key for the provider.",
  docMd: "## syncs\n\nDeployed sync functions and their models.",
  columns: [
    ...scriptColumns("Sync"),
    C.str("runs", "Schedule, e.g. 'every 30 minutes'.", "runs"),
    C.bool("enabled", "Whether the sync is enabled.", "enabled"),
    C.bool("auto_start", "Whether it starts automatically for new connections.", "auto_start"),
    C.bool("track_deletes", "Whether deletions are detected (records get last_action DELETED).", "track_deletes"),
    C.json(
      "json_schema",
      "JSON Schema of the returned models ({definitions: {Model: …}}), or NULL.",
      (r) => r.json_schema ?? null,
    ),
  ],
  page: async (cfg) => done(scriptsOf(await nangoGet(cfg, "/scripts/config", [["format", "nango"]]), "syncs")),
  examples: [
    {
      sql: `SELECT provider_config_key, name, models, runs FROM ${Q}.syncs WHERE enabled ORDER BY provider_config_key, name`,
      description: "Enabled syncs and the models they produce",
    },
    {
      sql: `SELECT provider_config_key, unnest(models) AS model FROM ${Q}.syncs ORDER BY ALL`,
      description: "Every (integration, model) pair records() can read",
    },
  ],
});

export const actions = defineNangoCatalogTable({
  name: "actions",
  key: ["provider_config_key", "name"],
  foreignKeys: [{ column: "provider_config_key", table: "integrations", refColumn: "unique_key" }],
  description: "Action functions deployed in this Nango environment (listed only; this worker never triggers them)",
  title: "Nango Actions",
  category: "syncs",
  keywords: "nango, actions, functions, tools, deployed scripts, endpoints",
  docLlm:
    "Every action deployed to the environment (GET /scripts/config), one row per (provider_config_key, name): " +
    "models it returns, description, version, last_deployed, scopes, endpoints and input (the input model). " +
    "Listed for inventory and audit only; the worker is read-only and never triggers an action. " +
    "Join nango.main.integrations ON integrations.unique_key = actions.provider_config_key for the provider.",
  docMd: "## actions\n\nDeployed action functions (inventory only — never executed).",
  columns: [...scriptColumns("Action"), C.json("input", "Input model reference, as JSON.", (r) => r.input ?? null)],
  page: async (cfg) => done(scriptsOf(await nangoGet(cfg, "/scripts/config", [["format", "nango"]]), "actions")),
  examples: [
    {
      sql: `SELECT provider_config_key, name, description FROM ${Q}.actions ORDER BY provider_config_key, name`,
      description: "Deployed actions per integration",
    },
  ],
});

// ------------------------------------------------------------------ sync status

/** Sum added / updated / deleted over the models in a sync's latestResult. */
export function resultTotals(latest: unknown): { added: number; updated: number; deleted: number } | null {
  if (!latest || typeof latest !== "object") return null;
  const t = { added: 0, updated: 0, deleted: 0 };
  for (const m of Object.values(latest as Record<string, Row>)) {
    if (!m || typeof m !== "object") continue;
    for (const k of ["added", "updated", "deleted"] as const) if (typeof m[k] === "number") t[k] += m[k];
  }
  return t;
}

const sumValues = (v: unknown): bigint | null =>
  v && typeof v === "object"
    ? BigInt(
        Object.values(v as Record<string, unknown>).reduce<number>((a, x) => a + (typeof x === "number" ? x : 0), 0),
      )
    : null;

export const connectionSyncs = defineNangoCatalogTable({
  name: "connection_syncs",
  key: ["id"],
  foreignKeys: [{ column: "provider_config_key", table: "integrations", refColumn: "unique_key" }],
  description: "Status of every sync on every connection: state, last finish, next run and record counts",
  title: "Nango Connection Syncs",
  category: "syncs",
  keywords: "nango, sync status, running, paused, error, last sync, next sync, record count, monitoring",
  docLlm:
    "One row per (integration, connection, sync[, variant]) from GET /sync/status: status (RUNNING, PAUSED, " +
    "STOPPED, SUCCESS, ERROR), sync_type (INITIAL / INCREMENTAL), finished_at, next_scheduled_sync_at, " +
    "frequency, total_records and record_count (per model, JSON), last_added / last_updated / last_deleted " +
    "(the latest run's changes summed over models), latest_result and checkpoint (JSON). Filtering on " +
    "provider_config_key, connection_id or sync_name narrows the API calls; otherwise every integration is read.",
  docMd: "## connection_syncs\n\nSync health per connection (GET /sync/status).",
  pushdown:
    "`provider_config_key` = / IN → only those integrations; `connection_id` = → `connection_id`; " +
    "`sync_name` = / IN → `syncs=a,b` (otherwise `syncs=*`).",
  columns: [
    C.str("provider_config_key", "Integration id.", "provider_config_key", false),
    C.str("connection_id", "The connection the sync runs for (connections.connection_id).", "connection_id"),
    C.str("sync_name", "Sync name (syncs.name).", "name"),
    C.str("variant", "Sync variant ('base' unless variants are used).", "variant"),
    C.str("status", "RUNNING, PAUSED, STOPPED, SUCCESS or ERROR.", "status"),
    C.str("sync_type", "Most recent run type: INITIAL or INCREMENTAL.", "type"),
    C.time("finished_at", "When the most recent run finished.", "finishedAt"),
    C.time("next_scheduled_sync_at", "When the next run is scheduled.", "nextScheduledSyncAt"),
    C.str("frequency", "Execution frequency, e.g. 'every hour'.", "frequency"),
    C.bigint("total_records", "Count of records currently stored, summed over the sync's models.", (r) =>
      sumValues(r.recordCount),
    ),
    C.json("record_count", "Records stored per model, as JSON.", (r) => r.recordCount ?? null),
    C.bigint(
      "last_added",
      "Count of records the latest run added (all models).",
      (r) => resultTotals(r.latestResult)?.added ?? null,
    ),
    C.bigint(
      "last_updated",
      "Count of records the latest run updated (all models).",
      (r) => resultTotals(r.latestResult)?.updated ?? null,
    ),
    C.bigint(
      "last_deleted",
      "Count of records the latest run deleted (all models).",
      (r) => resultTotals(r.latestResult)?.deleted ?? null,
    ),
    C.json(
      "latest_result",
      "Latest run's per-model added/updated/deleted counts, as JSON.",
      (r) => r.latestResult ?? null,
    ),
    C.json("checkpoint", "Last checkpoint saved by the sync, as JSON (NULL when none).", (r) => r.checkpoint ?? null),
    C.str("id", "Nango's id for this sync on this connection (unique per row).", "id", false),
  ],
  page: async (cfg, scan, cursor) => {
    // Cursor: JSON list of integration keys still to read.
    let keys: string[];
    if (cursor) keys = JSON.parse(cursor) as string[];
    else {
      keys =
        eqValues(scan.constraints, "provider_config_key") ??
        listOf(await nangoGet(cfg, "/integrations")).map((i) => String(i.unique_key));
    }
    const key = keys[0];
    if (key === undefined) return done([]);
    const rest = keys.slice(1);
    const names = eqValues(scan.constraints, "sync_name");
    const conns = eqValues(scan.constraints, "connection_id");
    const query: Query = [
      ["provider_config_key", key],
      ["syncs", names?.length ? names.join(",") : "*"],
    ];
    if (conns?.length === 1) query.push(["connection_id", conns[0] as string]);
    const next = rest.length ? JSON.stringify(rest) : null;
    if (names?.length === 0 || conns?.length === 0) return { rows: [], next };
    // A pushed connection_id that is not on this integration (or an unknown key) is "no rows".
    const res = await nangoRequest(cfg, "/sync/status", { query, passStatuses: [404] });
    const rows = res.status === 404 ? [] : listOf(res.body, "syncs").map((s) => ({ ...s, provider_config_key: key }));
    return { rows, next };
  },
  examples: [
    {
      sql: `SELECT provider_config_key, connection_id, sync_name, finished_at FROM ${Q}.connection_syncs WHERE status = 'ERROR' ORDER BY ALL`,
      description: "Failing syncs",
    },
    {
      sql: `SELECT sync_name, sum(total_records) AS records FROM ${Q}.connection_syncs WHERE provider_config_key = 'github-prod' GROUP BY sync_name ORDER BY records DESC`,
      description: "Records stored per sync for one integration",
    },
  ],
});

// ------------------------------------------------------------------ environment

export const environmentVariables = defineNangoCatalogTable({
  name: "environment_variables",
  key: ["name"],
  description: "Names of the environment variables set in this Nango environment (values are never returned)",
  title: "Nango Environment Variables",
  category: "environment",
  keywords: "nango, environment variables, configuration, env vars, settings",
  docLlm:
    "The environment variables defined for the Nango environment's functions (GET /environment-variables): " +
    "name and is_set (false when the value is empty). Values are secrets and are dropped inside the worker; " +
    "use this to audit which variables exist.",
  docMd: "## environment_variables\n\nEnvironment variable names (values are masked out entirely).",
  columns: [
    C.str("name", "Variable name.", "name", false),
    C.bool("is_set", "True when the variable has a non-empty value (the value itself is never returned).", "is_set"),
  ],
  page: async (cfg) =>
    done(
      listOf(await nangoGet(cfg, "/environment-variables")).map((v) => ({
        name: v.name,
        is_set: typeof v.value === "string" && v.value !== "",
      })),
    ),
  examples: [
    {
      sql: `SELECT name FROM ${Q}.environment_variables WHERE NOT is_set ORDER BY name`,
      description: "Environment variables defined without a value",
    },
  ],
});

export const environments = defineNangoCatalogTable({
  name: "environments",
  key: ["name"],
  description: "Environments in the Nango account (needs an account API key in the nango secret)",
  title: "Nango Environments",
  category: "environment",
  keywords: "nango, environments, production, staging, account",
  docLlm:
    "The environments of the Nango account (GET /environments): numeric_id, uuid, name and is_production. This is an " +
    "account-level endpoint: the nango secret must hold an Account API key, not an environment secret key " +
    "(environment keys get HTTP 401).",
  docMd: "## environments\n\nAccount environments (requires an account API key).",
  pushdown: "`name` = → `name`.",
  columns: [
    C.bigint("numeric_id", "Nango's numeric environment identifier (an id, not a quantity).", "id"),
    C.str("uuid", "Environment UUID.", "uuid"),
    C.str("name", "Environment name, e.g. 'prod'.", "name", false),
    C.bool("is_production", "Whether this is a production environment.", "is_production"),
  ],
  page: async (cfg, scan) => {
    const names = eqValues(scan.constraints, "name");
    const query: Query = names?.length === 1 ? [["name", names[0] as string]] : [];
    return done(listOf(await nangoGet(cfg, "/environments", query)));
  },
  examples: [
    {
      sql: `SELECT name, is_production FROM ${Q}.environments ORDER BY name`,
      description: "The account's environments",
    },
  ],
});

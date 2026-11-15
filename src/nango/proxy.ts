/**
 * `proxy(connection_id, provider_config_key, path, …)` — call any API Nango brokers,
 * read-only, with Nango-managed (and refreshed) credentials.
 *
 * The request goes to `<host>/proxy/<path>` with `Connection-Id` and
 * `Provider-Config-Key`; Nango adds the connection's credential and forwards it to the
 * provider's base URL. Caller headers travel as `Nango-Proxy-<name>`, which Nango
 * passes on as `<name>`. Rows are the elements of the JSON array at `response_path`
 * (dotted path or JSON pointer), or the whole body.
 *
 * Pagination mirrors Nango's proxy paginate config (`type` cursor / link / offset with
 * the same field names; `paginate := 'provider'` uses the provider's default from the
 * catalog). The next request lives in the scan state, so long scans resume over HTTP.
 *
 * Only GET and HEAD are allowed: this worker is read-only, so POST / PUT / PATCH /
 * DELETE are rejected at bind (method choices) and again before any request is sent.
 */

import { defineTableFunction, formatPushedFilters, int64, utf8 } from "@query-farm/vgi";
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
  seg,
} from "./client.ts";
import { at, C, type Col, type Row, rowsToBatch, schemaOf } from "./table.ts";

const Q = "nango.main";
export const READ_METHODS = ["GET", "HEAD"] as const;

export interface Pagination {
  type: "cursor" | "link" | "offset";
  limit?: number | string;
  limit_name_in_request?: string;
  response_path?: string;
  cursor_path_in_response?: string;
  cursor_name_in_request?: string;
  link_rel_in_response_header?: string;
  link_path_in_response_body?: string;
  offset_name_in_request?: string;
  offset_start_value?: number;
  offset_calculation_method?: "per-page" | "by-response-size";
  in_body?: boolean;
}

const REQUIRED: Record<Pagination["type"], (keyof Pagination)[]> = {
  cursor: ["cursor_path_in_response", "cursor_name_in_request"],
  link: [],
  offset: ["offset_name_in_request"],
};

/** Validate a pagination config object (Nango's field names). */
export function validatePagination(p: unknown): Pagination {
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new NangoError("paginate must be a JSON object");
  const o = p as Pagination;
  if (!["cursor", "link", "offset"].includes(o.type)) {
    throw new NangoError("paginate.type must be 'cursor', 'link' or 'offset'");
  }
  for (const k of REQUIRED[o.type]) {
    if (typeof o[k] !== "string" || !o[k]) throw new NangoError(`paginate.${k} is required for type '${o.type}'`);
  }
  if (o.in_body) throw new NangoError("paginate.in_body is for request bodies; this read-only worker sends GET only");
  if (o.type === "link" && !o.link_rel_in_response_header && !o.link_path_in_response_body) {
    o.link_rel_in_response_header = "next";
  }
  return o;
}

/** Parse a JSON object of string-ish values (params / headers). Arrays repeat the key. */
export function parsePairs(raw: string | null | undefined, what: string): Query {
  if (raw == null || raw.trim() === "") return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new NangoError(`${what} must be a JSON object, e.g. '{"per_page": 100}', got ${raw}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new NangoError(`${what} must be a JSON object`);
  const out: Query = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const vals = Array.isArray(val) ? val : [val];
    for (const x of vals) {
      if (x === null || x === undefined) continue;
      if (typeof x === "object") throw new NangoError(`${what}.${k} must be a string, number or boolean`);
      out.push([k, String(x)]);
    }
  }
  return out;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Turn caller headers into Nango-Proxy-<name> headers. */
export function proxyHeaders(pairs: Query): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) {
    if (!HEADER_NAME.test(k)) throw new NangoError(`headers: '${k}' is not a valid header name`);
    out[`Nango-Proxy-${k}`] = v;
  }
  return out;
}

/** Split a caller path into a `/`-rooted path and its query pairs. */
export function splitPath(path: string): { path: string; query: Query } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new NangoError("path must be relative to the provider's base URL (e.g. '/user/repos'), not a full URL");
  }
  const [p, q] = path.split("?", 2) as [string, string | undefined];
  const clean = `/${p.replace(/^\/+/, "")}`;
  if (clean.split("/").some((s) => s === "..")) throw new NangoError("path must not contain '..' segments");
  return { path: clean, query: q ? [...new URLSearchParams(q).entries()] : [] };
}

/** Parse an RFC 8288 Link header into rel → URL. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = part.match(/<([^>]+)>\s*;(.*)/);
    if (!m) continue;
    const rel = m[2]?.match(/rel="?([^";]+)"?/);
    if (rel?.[1] && m[1]) for (const r of rel[1].trim().split(/\s+/)) out[r] = m[1];
  }
  return out;
}

/**
 * Turn a next-page link into a proxy path relative to the provider's base URL. An
 * absolute link must start with that base URL: the proxy will only ever send the
 * connection's credential to the provider, never to a host a response names.
 */
export function linkToPath(link: string, baseUrl: string): { path: string; query: Query } {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(link)) return splitPath(link);
  const base = baseUrl.replace(/\/+$/, "");
  if (!base || !(link === base || link.startsWith(`${base}/`) || link.startsWith(`${base}?`))) {
    throw new NangoError(
      `refusing to follow a pagination link outside the provider's base URL (${new URL(link).origin})`,
    );
  }
  return splitPath(link.slice(base.length) || "/");
}

/** The items on one page: the array at `responsePath`, or the body. */
export function extractItems(body: unknown, responsePath: string | undefined): unknown[] {
  const v = responsePath ? at(body, responsePath) : body;
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

interface ProxyArgs {
  connection_id: string;
  provider_config_key: string;
  path: string;
  method: string;
  params: string | null;
  headers: string | null;
  response_path: string | null;
  paginate: string | null;
  max_pages: bigint;
}

interface ProxyState {
  started: boolean;
  done: boolean;
  /** Pages read so far. */
  page: number;
  /** Next request: path + JSON-encoded query pairs. */
  path: string;
  query: string;
  offset: number;
  /** Resolved pagination config (JSON) or "" for none. */
  pag: string;
  responsePath: string;
  baseUrl: string;
}

const COLUMNS: Col[] = [
  C.int("page", "1-based page number the row came from.", "page"),
  C.int("item_index", "0-based position of the item within its page.", "item_index"),
  C.int("http_status", "HTTP status of the page's response.", "http_status"),
  C.json("item", "One element of the response (at response_path), as JSON. For HEAD: the response headers.", "item"),
];
for (const c of COLUMNS.slice(0, 3)) c.nullable = false;
const OUT = schemaOf(COLUMNS);

async function providerOf(cfg: NangoConfig, key: string): Promise<Row> {
  const integ = (await nangoGet(cfg, `/integrations/${seg(key)}`)) as Row;
  const provider = integ?.data?.provider;
  if (typeof provider !== "string") throw new NangoError(`integration '${key}' has no provider`);
  const p = (await nangoGet(cfg, `/providers/${seg(provider)}`)) as Row;
  return (p?.data ?? {}) as Row;
}

export const proxy = defineTableFunction<ProxyArgs, ProxyState>({
  name: "proxy",
  description: "Read any API Nango brokers through the Nango proxy (GET/HEAD only) with Nango-managed credentials",
  args: {
    connection_id: utf8(),
    provider_config_key: utf8(),
    path: utf8(),
    method: utf8(),
    params: utf8(),
    headers: utf8(),
    response_path: utf8(),
    paginate: utf8(),
    max_pages: int64(),
  },
  argDefaults: { method: "GET", params: null, headers: null, response_path: null, paginate: null, max_pages: 100 },
  argDocs: {
    connection_id: "Connection id whose credential Nango should use.",
    provider_config_key: "Integration id (provider_config_key) of that connection.",
    path: "API path relative to the provider's base URL, e.g. '/user/repos' (a '?query' part is allowed).",
    method: "HTTP method (named): GET (default) or HEAD. Mutating methods are rejected — the worker is read-only.",
    params: "Query parameters as a JSON object (named), e.g. '{\"per_page\": 100}'; array values repeat the key.",
    headers: "Extra request headers as a JSON object (named); sent as Nango-Proxy-<name> and forwarded upstream.",
    response_path: "Where the rows are in the JSON response (named): dotted path ('data.items') or JSON pointer.",
    paginate:
      "Pagination (named): NULL = one page; 'provider' = the provider's default from the catalog; or a JSON " +
      "object in Nango's proxy paginate format ({type: cursor|link|offset, …}).",
    max_pages: "Stop after this many pages (named, 1 to 10000).",
  },
  argConstraints: {
    method: { choices: [...READ_METHODS] },
    max_pages: { ge: 1, le: 10000 },
  },
  onBind: (params) =>
    params.resolvedSecretsProvided ? { outputSchema: OUT } : { outputSchema: OUT, lookupSecretTypes: [SECRET_TYPE] },
  filterPushdown: true,
  autoApplyFilters: true,
  initialState: () => ({
    started: false,
    done: false,
    page: 0,
    path: "",
    query: "[]",
    offset: 0,
    pag: "",
    responsePath: "",
    baseUrl: "",
  }),
  process: async (params, state, out) => {
    const a = params.args;
    const method = String(a.method ?? "GET").toUpperCase();
    if (!(READ_METHODS as readonly string[]).includes(method)) {
      throw new NangoError(`proxy: method ${method} is not allowed; this worker is read-only (GET or HEAD)`);
    }
    const cfg = configFromSecrets(params.secrets);
    log.debug(`proxy: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
    if (!state.started) {
      state.started = true;
      const first = splitPath(a.path);
      let pag: Pagination | undefined;
      const raw = a.paginate?.trim();
      if (raw && raw.toLowerCase() !== "none") {
        if (raw.toLowerCase() === "provider") {
          const prov = await providerOf(cfg, a.provider_config_key);
          if (!prov.proxy?.paginate) {
            throw new NangoError(
              `provider '${prov.name}' has no default proxy pagination; pass a paginate JSON object`,
            );
          }
          pag = validatePagination({ ...prov.proxy.paginate });
          state.baseUrl = String(prov.proxy?.base_url ?? "");
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new NangoError(`paginate must be NULL, 'provider' or a JSON object, got ${raw}`);
          }
          pag = validatePagination(parsed);
        }
      }
      const query = [...first.query, ...parsePairs(a.params, "params")];
      if (
        pag?.limit !== undefined &&
        pag.limit_name_in_request &&
        !query.some(([k]) => k === pag.limit_name_in_request)
      ) {
        query.push([pag.limit_name_in_request, String(pag.limit)]);
      }
      if (pag?.type === "offset") {
        state.offset = Number(pag.offset_start_value ?? 0);
        const name = pag.offset_name_in_request as string;
        if (!query.some(([k]) => k === name)) query.push([name, String(state.offset)]);
      }
      state.path = first.path;
      state.query = JSON.stringify(query);
      state.pag = pag ? JSON.stringify(pag) : "";
      state.responsePath = a.response_path ?? pag?.response_path ?? "";
    }
    if (state.done) {
      out.finish();
      return;
    }
    const pag = state.pag ? (JSON.parse(state.pag) as Pagination) : undefined;
    const query = JSON.parse(state.query) as Query;
    const res = await nangoRequest(cfg, `/proxy${state.path}`, {
      method: method as "GET" | "HEAD",
      query,
      headers: {
        "Connection-Id": a.connection_id,
        "Provider-Config-Key": a.provider_config_key,
        ...proxyHeaders(parsePairs(a.headers, "headers")),
      },
    });
    state.page += 1;
    const items =
      method === "HEAD"
        ? [Object.fromEntries(res.headers.entries())]
        : extractItems(res.body, state.responsePath || undefined);
    const rows: Row[] = items.map((item, i) => ({ page: state.page, item_index: i, http_status: res.status, item }));

    // Work out the next request (or stop).
    state.done = true;
    if (pag && method === "GET" && items.length > 0 && state.page < Number(a.max_pages ?? 100)) {
      const set = (name: string, value: string) => {
        const q = query.filter(([k]) => k !== name);
        q.push([name, value]);
        state.query = JSON.stringify(q);
      };
      if (pag.type === "cursor") {
        const next = at(res.body, pag.cursor_path_in_response as string);
        if (next !== undefined && next !== null && next !== "") {
          set(pag.cursor_name_in_request as string, String(next));
          state.done = false;
        }
      } else if (pag.type === "link") {
        const link = pag.link_path_in_response_body
          ? at(res.body, pag.link_path_in_response_body)
          : parseLinkHeader(res.headers.get("Link"))[pag.link_rel_in_response_header ?? "next"];
        if (typeof link === "string" && link) {
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(link) && !state.baseUrl) {
            state.baseUrl = String((await providerOf(cfg, a.provider_config_key)).proxy?.base_url ?? "");
          }
          const next = linkToPath(link, state.baseUrl);
          state.path = next.path;
          state.query = JSON.stringify(next.query);
          state.done = false;
        }
      } else {
        const limit = pag.limit !== undefined ? Number(pag.limit) : undefined;
        if (!(limit && items.length < limit)) {
          state.offset += pag.offset_calculation_method === "per-page" ? 1 : items.length;
          set(pag.offset_name_in_request as string, String(state.offset));
          state.done = false;
        }
      }
    } else if (pag && items.length > 0 && state.page >= Number(a.max_pages ?? 100)) {
      log.info(`proxy: stopped after max_pages=${a.max_pages}`);
    }
    if (rows.length) out.emit(rowsToBatch(COLUMNS, rows, OUT));
    else if (state.done) out.finish();
  },
  tags: {
    domain: "integrations",
    ...objectTags({
      title: "Nango Proxy (read-only)",
      category: "proxy",
      keywords: "nango, proxy, api call, managed oauth, credentials, pagination, rest api, github, hubspot, any api",
      docLlm:
        "Call any of the 400+ APIs Nango supports with the connection's Nango-managed, auto-refreshed credential: " +
        "proxy(connection_id, provider_config_key, path, method := 'GET', params := NULL, headers := NULL, " +
        "response_path := NULL, paginate := NULL, max_pages := 100). `path` is relative to the provider's API base " +
        "URL (see providers.proxy_base_url), e.g. '/user/repos' for GitHub. Each row is one element of the JSON " +
        "array at response_path (e.g. 'results' or 'data.items'; JSON pointer '/data/items' also works), or the " +
        "whole body when it is an object, as `item` JSON — extract fields with item->>'name'. " +
        "params/headers are JSON objects. paginate: NULL reads one page; 'provider' uses the provider's default " +
        '(providers.proxy_paginate); or pass Nango\'s config, e.g. \'{"type":"cursor","cursor_path_in_response":' +
        '"paging.next.after","cursor_name_in_request":"after","limit_name_in_request":"limit","limit":100,' +
        '"response_path":"results"}\', \'{"type":"link"}\' (Link header rel=next) or ' +
        '\'{"type":"offset","offset_name_in_request":"start","limit":100,"limit_name_in_request":"limit"}\'. ' +
        "Only GET and HEAD are allowed (read-only). HTTP 429 from Nango or the upstream API is retried after Retry-After.",
      docMd:
        "## proxy(connection_id, provider_config_key, path, method := 'GET', params := NULL, headers := NULL, response_path := NULL, paginate := NULL, max_pages := 100)\n\n" +
        "Read-only calls through the Nango proxy. Columns: `page`, `item_index`, `http_status`, `item` (JSON).\n\n" +
        "- **Read-only:** `method` accepts GET and HEAD only; POST/PUT/PATCH/DELETE are rejected.\n" +
        "- **Pagination** mirrors Nango's proxy paginate config: `cursor` (cursor_path_in_response → " +
        "cursor_name_in_request), `link` (Link header rel or link_path_in_response_body; absolute links must stay " +
        "on the provider's base URL), `offset` (offset_name_in_request, per-page or by-response-size). " +
        "`paginate := 'provider'` uses the catalog default.\n" +
        "- **Credentials:** Nango adds and refreshes them; the worker only holds your Nango secret key.",
    }),
    "vgi.result_columns_schema": JSON.stringify(
      COLUMNS.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  },
  examples: [
    {
      sql: `SELECT item->>'full_name' AS repo FROM ${Q}.proxy('conn-ada-github', 'github-prod', '/user/repos', paginate := 'provider', params := '{"per_page": 50}') ORDER BY repo`,
      description: "Every GitHub repository the connection can see, following Link-header pages",
    },
    {
      sql: `SELECT item->>'id' AS id, item->'properties'->>'email' AS email FROM ${Q}.proxy('conn-acme-hubspot', 'hubspot', '/crm/v3/objects/contacts', paginate := 'provider') ORDER BY id`,
      description: "HubSpot contacts through the proxy with the provider's cursor pagination",
    },
  ],
});

/**
 * Nango API client: the `nango` secret, rate limits and retries.
 *
 * - **Auth.** A `nango` DuckDB secret carries an environment `SECRET_KEY` (sent as
 *   `Authorization: Bearer <key>`) and an optional `HOST` (default
 *   https://api.nango.dev; set it for a self-hosted Nango). The key is read from the
 *   secret on every call and never enters table-function state.
 * - **Rate limits.** A 429 waits for `Retry-After` (seconds) or `X-RateLimit-Reset`
 *   (epoch seconds), bounded; 5xx and network errors retry with exponential backoff.
 *   This applies to proxied calls too, so an upstream 429 Nango passes back is honoured.
 * - **Secrets never leak.** Errors quote the path only; credential-bearing responses
 *   are reduced by the callers before anything reaches a row.
 */

import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "nango";
export const DEFAULT_HOST = "https://api.nango.dev";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a rate-limit reset. */
export const MAX_RATE_WAIT_MS = 65_000;
const USER_AGENT = `vgi-nango-worker/${VERSION}`;

export class NangoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface NangoConfig {
  host: string;
  secretKey: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a host URL: https, or http only for a loopback server (fixtures, local self-host). */
export function normalizeHost(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new NangoError(`nango secret: host '${raw}' is not a URL (expected e.g. https://api.nango.dev)`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new NangoError("nango secret: host must use https:// (http:// is accepted only for 127.0.0.1/localhost)");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `nango` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): NangoConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new NangoError(
      "no nango secret: run CREATE SECRET (TYPE nango, SECRET_KEY '<environment secret key>') " +
        "and add HOST 'https://nango.example.com' for a self-hosted Nango",
    );
  }
  const secretKey = str(s.secret_key);
  if (!secretKey) throw new NangoError("nango secret: secret_key is required (Environment Settings > secret key)");
  return { host: normalizeHost(str(s.host) ?? DEFAULT_HOST), secretKey };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a 429 asks us to wait: Retry-After (seconds or HTTP date), else X-RateLimit-Reset (epoch s). */
export function retryDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const retry = headers.get("Retry-After");
  if (retry && /^\d+$/.test(retry.trim())) return Number(retry) * 1000;
  if (retry) {
    const t = Date.parse(retry);
    if (!Number.isNaN(t)) return Math.max(0, t - now);
  }
  const reset = headers.get("X-RateLimit-Reset");
  if (reset && /^\d+$/.test(reset)) {
    const n = Number(reset);
    // Epoch seconds; small numbers are "seconds from now".
    return n > 1_000_000_000 ? Math.max(0, n * 1000 - now) + 250 : n * 1000;
  }
  return undefined;
}

export type Query = [string, string][];

export interface NangoResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export interface RequestOptions {
  query?: Query;
  headers?: Record<string, string>;
  method?: "GET" | "HEAD";
  /** Statuses returned to the caller instead of raised (e.g. 404 → "no such object"). */
  passStatuses?: number[];
}

/** Build `<host><path>?<query>`; `path` already starts with `/`. */
export function buildUrl(cfg: NangoConfig, path: string, query: Query = []): string {
  const qs = new URLSearchParams();
  for (const [k, v] of query) qs.append(k, v);
  const q = qs.toString();
  return `${cfg.host}${path}${q ? `?${q}` : ""}`;
}

/** One Nango API call with retries. JSON bodies are decoded; others come back as text. */
export async function nangoRequest(cfg: NangoConfig, path: string, opts: RequestOptions = {}): Promise<NangoResponse> {
  const method = opts.method ?? "GET";
  const url = buildUrl(cfg, path, opts.query);
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...opts.headers,
          Authorization: `Bearer ${cfg.secretKey}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new NangoError(`${method} ${path} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (res.ok || opts.passStatuses?.includes(res.status)) {
      const text = method === "HEAD" ? "" : await res.text();
      let body: unknown = text;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      } else body = null;
      return { status: res.status, headers: res.headers, body };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new NangoError(
        `${method} ${path} failed with HTTP ${res.status}: ${await errorSummary(res, method)}`,
        res.status,
      );
    }
    await res.body?.cancel();
    const delay =
      res.status === 429 ? Math.min(retryDelayMs(res.headers) ?? 1000 * attempt, MAX_RATE_WAIT_MS) : 250 * 2 ** attempt;
    log.info(`nango: HTTP ${res.status} for ${method} ${path}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** GET a JSON body (convenience). */
export async function nangoGet(cfg: NangoConfig, path: string, query: Query = []): Promise<unknown> {
  return (await nangoRequest(cfg, path, { query })).body;
}

/** Nango errors are `{error: {code, message}}`; keep the message short. */
async function errorSummary(res: Response, method: string): Promise<string> {
  if (method === "HEAD") return res.statusText || "(no body)";
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string } | string; message?: string };
    if (j.error && typeof j.error === "object") {
      return [j.error.code, j.error.message].filter(Boolean).join(" - ") || text.slice(0, 300);
    }
    if (typeof j.error === "string") return j.error;
    if (typeof j.message === "string") return j.message;
  } catch {}
  return text.slice(0, 300);
}

/** Encode one path segment (connection ids, keys and provider names may contain anything). */
export const seg = (s: string) => encodeURIComponent(s);

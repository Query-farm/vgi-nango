// Unit tests. The SQL-level tests live in test/sql and run through DuckDB over every transport.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import {
  configFromSecrets,
  DEFAULT_HOST,
  type NangoConfig,
  nangoGet,
  nangoRequest,
  normalizeHost,
  retryDelayMs,
} from "../src/nango/client.ts";
import {
  extractItems,
  linkToPath,
  parseLinkHeader,
  parsePairs,
  proxyHeaders,
  splitPath,
  validatePagination,
} from "../src/nango/proxy.ts";
import type { Constraint } from "../src/nango/pushdown.ts";
import { argTimeMs, findModelSchema, META_COLUMNS, modelColumns, recordsQuery } from "../src/nango/records.ts";
import { connectionDetail, parseTags, resultTotals, scriptsOf } from "../src/nango/resources.ts";
import { asTime, at } from "../src/nango/table.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = (await Bun.file(join(ROOT, "test", "fixtures", "nango-env.json")).json()) as Record<string, unknown>;

// ------------------------------------------------------------------- client

test("host: https required except loopback; default api.nango.dev", () => {
  expect(normalizeHost("https://nango.example.com/")).toBe("https://nango.example.com");
  expect(normalizeHost("http://localhost:3003")).toBe("http://localhost:3003");
  expect(() => normalizeHost("http://nango.example.com")).toThrow(/https/);
  expect(() => normalizeHost("nope")).toThrow(/not a URL/);
  expect(configFromSecrets({ s: { type: "nango", secret_key: "k" } })).toEqual({ host: DEFAULT_HOST, secretKey: "k" });
  expect(() => configFromSecrets({})).toThrow(/CREATE SECRET \(TYPE nango/);
  expect(() => configFromSecrets({ s: { type: "nango", host: "https://x.dev" } })).toThrow(/secret_key/);
});

test("retryDelayMs: Retry-After seconds, then X-RateLimit-Reset epoch seconds", () => {
  expect(retryDelayMs(new Headers({ "Retry-After": "3" }))).toBe(3000);
  expect(retryDelayMs(new Headers({ "X-RateLimit-Reset": "1010" }), 1_000_000)).toBe(1_010_000);
  expect(retryDelayMs(new Headers({ "X-RateLimit-Reset": "2000000000" }), 1_999_999_999_000)).toBe(1250);
  expect(retryDelayMs(new Headers())).toBeUndefined();
});

// ---------------------------------------------------------------- resources

test("connectionDetail keeps type and expiry, never tokens", () => {
  const conns = FIXTURE.connections as Record<string, unknown>[];
  for (const c of conns) {
    const d = connectionDetail(c);
    expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(Object.keys(d).sort()).toEqual([
      "credential_expires_at",
      "credential_type",
      "last_fetched_at",
      "updated_at",
    ]);
  }
  expect(connectionDetail(conns[0]).credential_type).toBe("OAUTH2");
  expect(connectionDetail(undefined).credential_type).toBeNull();
});

test("parseTags: JSON object of strings, keys lowercased", () => {
  expect(parseTags('{"End_User_Id": "u1"}')).toEqual({ end_user_id: "u1" });
  expect(parseTags(null)).toEqual({});
  expect(() => parseTags("[1]")).toThrow(/JSON object/);
  expect(() => parseTags('{"a": 1}')).toThrow(/string/);
});

test("scripts config flattening and latestResult totals", () => {
  const syncs = scriptsOf(FIXTURE.scripts_config, "syncs");
  expect(syncs.map((s) => `${s.provider_config_key}/${s.name}`)).toEqual([
    "github-prod/github-issues",
    "github-prod/github-repos",
    "hubspot/hubspot-contacts",
  ]);
  expect(scriptsOf({ data: FIXTURE.scripts_config }, "actions").length).toBe(2);
  expect(resultTotals({ A: { added: 1, updated: 2, deleted: 0 }, B: { added: 3 } })).toEqual({
    added: 4,
    updated: 2,
    deleted: 0,
  });
  expect(resultTotals(null)).toBeNull();
});

// ------------------------------------------------------------------ records

test("model columns: typed from JSON Schema, reserved names stay in _record", () => {
  const def = findModelSchema(FIXTURE.scripts_config, "github-prod", "GithubIssue");
  const { columns, typed } = modelColumns(def);
  expect(typed).toBe(true);
  const types = Object.fromEntries(columns.map((c) => [c.name, c.sqlType]));
  expect(types).toMatchObject({
    id: "VARCHAR",
    number: "BIGINT",
    labels: "VARCHAR[]",
    locked: "BOOLEAN",
    score: "DOUBLE",
    assignee: "VARCHAR",
    created_at: "TIMESTAMP WITH TIME ZONE",
    repo: "JSON",
    _record: "JSON",
  });
  expect(findModelSchema(FIXTURE.scripts_config, "github-prod", "GithubRepo")).toBeUndefined();
  expect(modelColumns(undefined).columns.map((c) => c.name)).toEqual(["id", ...META_COLUMNS.map((c) => c.name)]);
  const clash = modelColumns({ properties: { ID: { type: "string" }, id: { type: "integer" }, _record: {} } });
  expect(clash.columns.filter((c) => c.name.toLowerCase() === "id").length).toBe(1);
  expect(clash.columns.filter((c) => c.name === "_record").length).toBe(1);
});

const args = {
  integration: "g",
  connection_id: "c",
  model: "M",
  modified_after: null,
  filter: null,
  variant: null,
  page_size: 100n,
};
const ts = (iso: string) => BigInt(Date.parse(iso)) * 1000n;

test("recordsQuery: pushdown narrows only", () => {
  const cs: Constraint[] = [
    { kind: "cmp", column: "_nango_last_modified_at", op: "gt", value: ts("2026-11-10T09:00:00Z") },
    { kind: "in", column: "_nango_last_action", values: ["ADDED", "DELETED"] },
    { kind: "in", column: "id", values: ["a", "b"] },
  ];
  expect(recordsQuery(args, cs, "cur")).toEqual([
    ["model", "M"],
    ["limit", "100"],
    ["modified_after", "2026-11-10T08:59:59.999Z"],
    ["filter", "added,deleted"],
    ["ids", "a"],
    ["ids", "b"],
    ["cursor", "cur"],
  ]);
  // The later of the argument and the pushed bound wins.
  const q = recordsQuery({ ...args, modified_after: Number(ts("2026-11-12T00:00:00Z")) }, cs, "");
  expect(q?.find(([k]) => k === "modified_after")?.[1]).toBe("2026-11-12T00:00:00.000Z");
  // Contradictory filters: no request at all.
  expect(recordsQuery({ ...args, filter: "updated" }, cs, "")).toBeNull();
  // All three actions = no filter.
  expect(recordsQuery({ ...args, filter: "added,updated,deleted" }, [], "")?.some(([k]) => k === "filter")).toBe(false);
});

test("argTimeMs reads the SDK's microseconds", () => {
  expect(argTimeMs(1_700_000_000_000_000)).toBe(1_700_000_000_000);
  expect(argTimeMs(1_700_000_000_000_000n)).toBe(1_700_000_000_000);
});

test("asTime keeps Nango's microseconds", () => {
  expect(asTime("2023-09-18T15:20:35.941305+00:00")).toBe(ts("2023-09-18T15:20:35.941Z") + 305n);
  expect(asTime("2026-01-02T10:00:00Z")).toBe(ts("2026-01-02T10:00:00Z"));
  expect(asTime("garbage")).toBeNull();
});

// -------------------------------------------------------------------- proxy

test("proxy request shaping", () => {
  expect(splitPath("user/repos?per_page=2")).toEqual({ path: "/user/repos", query: [["per_page", "2"]] });
  expect(() => splitPath("https://evil.example.com/x")).toThrow(/relative/);
  expect(() => splitPath("/a/../b")).toThrow(/\.\./);
  expect(parsePairs('{"a": 1, "b": [true, "x"], "c": null}', "params")).toEqual([
    ["a", "1"],
    ["b", "true"],
    ["b", "x"],
  ]);
  expect(() => parsePairs('{"a": {"b": 1}}', "params")).toThrow(/string, number or boolean/);
  expect(proxyHeaders([["X-Trace", "1"]])).toEqual({ "Nango-Proxy-X-Trace": "1" });
  expect(() => proxyHeaders([["bad header", "1"]])).toThrow(/header name/);
});

test("pagination config validation mirrors Nango's field names", () => {
  expect(validatePagination({ type: "link" }).link_rel_in_response_header).toBe("next");
  expect(() => validatePagination({ type: "cursor", cursor_name_in_request: "after" })).toThrow(
    /cursor_path_in_response/,
  );
  expect(() => validatePagination({ type: "offset" })).toThrow(/offset_name_in_request/);
  expect(() => validatePagination({ type: "page" })).toThrow(/type/);
  expect(() => validatePagination({ type: "link", in_body: true })).toThrow(/GET only/);
});

test("links are followed only under the provider's base URL", () => {
  const base = "https://api.github.com";
  expect(linkToPath("https://api.github.com/user/repos?page=2", base)).toEqual({
    path: "/user/repos",
    query: [["page", "2"]],
  });
  expect(linkToPath("/user/repos?page=3", base).path).toBe("/user/repos");
  expect(() => linkToPath("https://evil.example.com/user/repos?page=2", base)).toThrow(/refusing/);
  expect(() => linkToPath("https://api.github.com.evil.example/x", base)).toThrow(/refusing/);
  expect(() => linkToPath("https://api.github.com/x", "")).toThrow(/refusing/);
  expect(parseLinkHeader('<https://a/x?page=2>; rel="next", <https://a/x?page=9>; rel="last"').next).toBe(
    "https://a/x?page=2",
  );
});

test("extractItems: response_path as dotted path or JSON pointer", () => {
  const body = { data: { items: [1, 2] }, one: { a: 1 } };
  expect(extractItems(body, "data.items")).toEqual([1, 2]);
  expect(extractItems(body, "/data/items")).toEqual([1, 2]);
  expect(extractItems(body, "one")).toEqual([{ a: 1 }]);
  expect(extractItems(body, "missing")).toEqual([]);
  expect(extractItems([3], undefined)).toEqual([3]);
  expect(at({ "a/b": 1 }, "/a~1b")).toBe(1);
});

// ---------------------------------------------------- against the replay server

describe("against the Nango replay server", () => {
  let mock: ReturnType<typeof Bun.spawn>;
  let cfg: NangoConfig;
  let client: VgiClient;

  beforeAll(async () => {
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`replay server did not report a port: ${text}`);
    cfg = { host: `http://127.0.0.1:${port}`, secretKey: "test-secret-key" };
    client = new VgiClient(subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")]));
  });

  afterAll(() => {
    client?.close();
    mock?.kill();
  });

  test("a 429 with Retry-After is waited out", async () => {
    const t0 = Date.now();
    const body = (await nangoGet(cfg, "/integrations")) as { data: unknown[] };
    expect(body.data.length).toBe(4);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  test("errors carry the HTTP status and Nango's code, not the key", async () => {
    const run = nangoRequest({ ...cfg, secretKey: "wrong" }, "/integrations");
    await expect(run).rejects.toThrow(/HTTP 401: unknown_account/);
    await expect(nangoGet(cfg, "/connections", [["bogus", "1"]])).rejects.toThrow(/HTTP 400: invalid_query_params/);
  });

  test("a scan without a nango secret explains how to create one", async () => {
    const run = async () => {
      for await (const _ of client.tableFunctionRows({
        functionName: "connections",
        arguments: new Arguments([], new Map()),
        int64: "bigint",
      })) {
        // no rows expected
      }
    };
    await expect(run()).rejects.toThrow(/CREATE SECRET \(TYPE nango/);
  });
});

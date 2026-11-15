<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query 400+ SaaS APIs Through Nango's Managed OAuth in DuckDB

> **vgi-nango** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-nango/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-nango/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

[Nango](https://nango.dev) is an open-source unified API and managed-OAuth platform: it
holds and refreshes your users' credentials for 400+ APIs. This worker uses Nango as an
auth broker for DuckDB, read-only. You can audit the integration setup, read the records
Nango syncs stored, and call any brokered API through the Nango proxy. DuckDB only ever
holds your Nango secret key. Tokens stay in Nango.

```sql
CREATE SECRET nango (TYPE nango, SECRET_KEY 'nango-secret-key…');

-- Connections whose OAuth tokens are broken or about to expire.
SELECT connection_id, provider, organization_id, credential_expires_at
FROM nango.main.connections()
WHERE has_auth_error OR credential_expires_at < now() + INTERVAL 1 DAY;

-- What a GitHub issues sync stored, changed in the last week (pushed down as modified_after).
SELECT number, title, state, _nango_last_action
FROM nango.main.records('github', 'user-42', 'GithubIssue')
WHERE _nango_last_modified_at > now() - INTERVAL 7 DAY;

-- Any API Nango brokers, read-only: every repo the user can see, following Link-header pages.
SELECT item->>'full_name' AS repo, (item->>'stargazers_count')::INT AS stars
FROM nango.main.proxy('user-42', 'github', '/user/repos', paginate := 'provider')
ORDER BY stars DESC;
```

## Functions and tables

All live in `nango.main`. "integration" means the same thing as `provider_config_key` and
`integrations.unique_key` everywhere.

| Object | Kind | What it returns |
|---|---|---|
| `providers` | table | Nango's provider catalog: `name`, `auth_mode`, `categories VARCHAR[]`, `docs`, `proxy_base_url`, default `proxy_paginate` |
| `integrations` | table | Configured integrations: `unique_key`, `provider`, timestamps, `missing_fields`, `is_configured` (client secrets are never requested) |
| `connections(tags := NULL, page_size := 100)` | table function | One row per connection: `connection_id`, `provider_config_key`, `end_user_id` / `end_user_email` / `organization_id` tags, `tags`, `metadata`, `errors STRUCT(type, log_id)[]`, `has_auth_error`, and the detail columns `credential_type`, `credential_expires_at`, `updated_at` and `last_fetched_at` |
| `syncs` | table | Deployed syncs: `models`, `runs`, `enabled`, `auto_start`, `track_deletes`, `json_schema` |
| `actions` | table | Deployed actions, listed only (never triggered) |
| `connection_syncs` | table | Sync status per connection: `status`, `finished_at`, `next_scheduled_sync_at`, `total_records`, latest run's added/updated/deleted |
| `environment_variables` | table | Variable `name` and `is_set` only (values are never returned) |
| `environments` | table | The account's environments (needs an **account** API key) |
| `records(integration, connection_id, model, modified_after := NULL, filter := NULL, variant := NULL, page_size := 100)` | table function | The records a sync stored, typed from the model's JSON Schema |
| `proxy(connection_id, provider_config_key, path, method := 'GET', params := NULL, headers := NULL, response_path := NULL, paginate := NULL, max_pages := 100)` | table function | `page`, `item_index`, `http_status`, `item JSON`, one row per element at `response_path` |

### Pushdown

Every function re-applies the pushed filters exactly, so translation only ever narrows
what Nango returns.

| Object | SQL | Nango parameter |
|---|---|---|
| `providers` | `name = / IN` | `GET /providers/{name}` per value |
| `integrations` | `unique_key = / IN` | `GET /integrations/{key}` per value |
| `connections()` | `connection_id =` | `connectionId` |
| `connections()` | `end_user_id`, `end_user_email`, `organization_id =`, and `tags :=` | `tags[<key>]=…` |
| `connections()` | detail columns projected or filtered | one `GET /connections/{id}?refresh_token=false` per row (skipped otherwise) |
| `connection_syncs` | `provider_config_key = / IN`, `connection_id =`, `sync_name = / IN` | integrations read, `connection_id`, `syncs=a,b` |
| `records()` | `_nango_last_modified_at > / >=` (and `modified_after :=`) | `modified_after` (1 ms earlier: Nango compares strictly) |
| `records()` | `_nango_last_action = / IN` (and `filter :=`) | `filter=added,deleted` |
| `records()` | `id = / IN` (≤ 100 values) | `ids` |
| `environments` | `name =` | `name` |

### Record columns

When the deployed sync has a JSON Schema for the model (`syncs.json_schema`), each model
property becomes its own column. `string` maps to `VARCHAR`, and `string` with
`format: date-time` maps to `TIMESTAMPTZ`. `integer` maps to `BIGINT`, `number` to
`DOUBLE`, `boolean` to `BOOLEAN`, and an array of strings to `VARCHAR[]`. Objects,
other arrays and `$ref`s become `JSON`. `null` in a type union only makes the column
nullable. Without a schema, the result is the hoisted `id` plus the payload as
`_record` JSON (`_record->>'field'`). Every row ends with `_nango_last_action`,
`_nango_last_modified_at`, `_nango_first_seen_at`, `_nango_deleted_at`,
`_nango_pruned_at`, `_nango_cursor` and `_record`. Deleted records are included; filter
`_nango_deleted_at IS NULL` for live ones.

### The proxy

`proxy()` sends `GET <host>/proxy/<path>` with `Connection-Id` and `Provider-Config-Key`.
Nango injects that connection's credential, refreshing it first if needed, and forwards
the call to the provider's base URL. `headers := '{"X-Foo": "1"}'` is sent as
`Nango-Proxy-X-Foo`, which Nango passes upstream as `X-Foo`. `params` is a JSON object;
an array value repeats the key.

- **Read-only.** `method` accepts `GET` (default) and `HEAD`. `POST`, `PUT`, `PATCH`
  and `DELETE` are rejected at bind and again before any request, because the worker
  never mutates an upstream service. `HEAD` returns one row whose `item` is the
  response headers.
- **Rows.** `response_path` is a dotted path (`data.items`) or a JSON pointer
  (`/data/items`). An array yields one row per element. An object yields one row.
- **Pagination** mirrors Nango's proxy `paginate` config and its field names:
  - `cursor`: `cursor_path_in_response` → `cursor_name_in_request`
  - `link`: the `Link` header's `link_rel_in_response_header` (default `next`), or
    `link_path_in_response_body`
  - `offset`: `offset_name_in_request` with `offset_start_value`, and
    `offset_calculation_method` set to `per-page` or `by-response-size` (the default)
  - `limit` + `limit_name_in_request` and `response_path` work as in Nango.
  - `paginate := 'provider'` uses the provider's default from the catalog
    (`providers.proxy_paginate`).

  A scan stops at an empty page, a short offset page, a missing cursor or link, or
  `max_pages`. An absolute next link must start with the provider's `proxy_base_url`.
  The connection's credential is never sent to a host that a response names. The next
  request is kept in the scan state, so long scans resume over the HTTP transport.

## Authentication

```sql
-- Nango Cloud
CREATE SECRET nango (TYPE nango, SECRET_KEY 'nango-environment-secret-key');
-- Self-hosted Nango
CREATE SECRET nango (TYPE nango, SECRET_KEY '…', HOST 'https://nango.internal.example.com');
```

`SECRET_KEY` is an environment secret key, sent as `Authorization: Bearer …`. `HOST`
defaults to `https://api.nango.dev`. It must be `https://`; plain `http://` is accepted
only for `localhost` / `127.0.0.1`. The `environments` table is account-level and needs
an account API key in `SECRET_KEY`. The key is read from the secret on every call and
never stored in scan state.

**Secrets never leak.**

- `connections()` reads `GET /connections/{id}` (with `refresh_token=false`) only when a
  detail column is needed. It reduces the response to the credential type, expiry and
  timestamps before a row is built. Access and refresh tokens, API keys and
  `connection_config` are dropped.
- Integrations are read without `include=credentials`.
- Environment variable values are dropped.

## Rate limits and retries

HTTP 429 from Nango or an upstream API that Nango passes back through the proxy waits
for `Retry-After` (seconds or a date) or `X-RateLimit-Reset`, up to 65 s. 5xx and
network errors retry with exponential backoff, up to 5 attempts. Every request has a
30 s timeout.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone --branch v0.1.0 https://github.com/Query-farm/vgi-nango.git && cd vgi-nango
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'nango' (TYPE vgi, LOCATION '/abs/path/to/vgi-nango/bin/vgi-nango-worker');
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'nango' (TYPE vgi, LOCATION '/abs/path/to/vgi-nango/bin/vgi-nango-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed) for Linux, macOS (arm64) and Windows.
Point `LOCATION` at the downloaded binary. The same binary serves HTTP with
`--http --port 8000` (see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (pushdown, schema typing, pagination, link safety, retries)
make test-sql                  # test/sql/nango.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Nango account. `test/mock_api/server.py` is a
stdlib-only replay of the Nango API, serving a hand-built environment
(`test/fixtures/nango-env.json`) in the response shapes of Nango's
[OpenAPI spec](https://github.com/NangoHQ/nango/blob/master/docs/spec.yaml). It:

- checks the Bearer key, and allows `/environments` only with an account key;
- rejects unknown query parameters;
- pages `/connections` (`limit` + `page`) and `/records` (`cursor`, with
  `modified_after` / `filter` / `ids`);
- answers a 429 and a 503 once each, so the retry paths always run.

Its `/proxy` route resolves the connection from `Connection-Id` + `Provider-Config-Key`.
It forwards `Nango-Proxy-*` headers and the connection's credential to a **fake
upstream API**. That upstream verifies that the credential belongs to a connection of
the right provider and serves Link-header, cursor and offset pagination plus an
upstream 429. The SQL tests read the replay's `/__requests` log to check exactly what
was pushed down and which connection the upstream saw.

A self-hosted Nango in Docker was not used for testing. Its stack (server, Postgres,
Redis, and a registered OAuth app for any real provider) adds weight without making
offline tests more faithful than the spec-shaped replay.

The metadata check runs with `execute: false` in CI, because every object needs a
`nango` secret for a live environment.

## Nango's license

This worker is a client of the Nango API. It contains no Nango code. The Nango server,
including self-hosted deployments, is licensed by Nango under the
[Elastic License 2.0 (ELv2)](https://github.com/NangoHQ/nango/blob/master/LICENSE).
ELv2 allows self-hosting for your own use but forbids offering Nango to third parties as
a hosted or managed service. Check Nango's terms for your deployment.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm

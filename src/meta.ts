/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "nango";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-nango";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  {
    name: "catalog",
    title: "Providers and Integrations",
    description: "Nango's provider catalog and the integrations (provider configs) set up in the environment.",
  },
  {
    name: "connections",
    title: "Connections",
    description: "End-user connections: tags, errors, and credential type and expiry (never tokens).",
  },
  {
    name: "syncs",
    title: "Syncs and Records",
    description: "Deployed syncs and actions, sync health, and the records syncs stored.",
  },
  {
    name: "proxy",
    title: "Proxy",
    description: "Read-only calls to any brokered API through the Nango proxy with managed credentials.",
  },
  {
    name: "environment",
    title: "Environment",
    description: "Environment variables (names only) and the account's environments.",
  },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Nango API reference](https://nango.dev/docs/reference/backend/http-api/authentication) and its [OpenAPI spec](https://github.com/NangoHQ/nango/blob/master/docs/spec.yaml)\n" +
  "- [Records API](https://nango.dev/docs/reference/api/records/get) — cursor paging, `modified_after`, `filter`\n" +
  "- [Proxy](https://nango.dev/docs/guides/proxy-requests) and its pagination config\n" +
  "- [Self-hosting Nango](https://nango.dev/docs/guides/self-hosting/free-self-hosting/overview)";

export const CATALOG_COMMENT =
  "Nango as SQL: its provider catalog, integrations, connections, syncs and synced records, plus read-only calls to 400+ APIs through the Nango proxy with Nango-managed credentials.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to a Nango environment (Nango Cloud or self-hosted), the open-source unified API " +
  "and managed-OAuth platform. Use it to (1) audit the integration setup: the provider catalog " +
  "(providers), configured integrations, end-user connections with their tags, errors and token expiry " +
  "(connections()), deployed syncs and actions, sync health per connection (connection_syncs) and environment variable names; " +
  "(2) read what syncs stored with records(integration, connection_id, model), typed from the model's JSON " +
  "Schema; and (3) call any brokered API read-only with proxy(connection_id, provider_config_key, path), " +
  "where Nango injects and refreshes the credential and the worker follows cursor / link / offset " +
  "pagination. Every object needs a `nango` DuckDB secret with SECRET_KEY (an environment secret key) and " +
  "optional HOST (default https://api.nango.dev). Access and refresh tokens, integration client secrets and " +
  "environment variable values are never returned. Upstream docs: https://nango.dev/docs ; API spec " +
  "https://github.com/NangoHQ/nango/blob/master/docs/spec.yaml .";

export const CATALOG_DOC_MD =
  "# Nango\n\n" +
  "Query a [Nango](https://nango.dev) environment from DuckDB, read-only: the provider catalog, " +
  "integrations, connections (credential type and expiry, never tokens), syncs, actions, sync status, " +
  "synced records, and any of the 400+ APIs Nango brokers through its proxy.\n\n" +
  "Create a `nango` secret with your environment `SECRET_KEY` (and `HOST` for a self-hosted Nango). " +
  "Filters push down into Nango's own parameters (`modified_after`, `filter`, `ids`, connection tags), " +
  "pagination cursors travel with the scan, and HTTP 429 is retried after `Retry-After`.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Nango objects as SQL. Parameterless listings are tables (providers, integrations, syncs, actions, " +
  "connection_syncs, environment_variables, environments); connections(tags := …) is a table function; " +
  "records(integration, connection_id, model, …) reads a sync's stored records; proxy(connection_id, " +
  "provider_config_key, path, …) calls the upstream API through Nango, GET/HEAD only. integration = " +
  "provider_config_key = integrations.unique_key throughout. All objects need a `nango` secret.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Nango's catalog, integrations, connections, syncs, records and the read-only proxy.\n\n" +
  "Listings are tables; `connections()`, `records()` and `proxy()` are table functions. " +
  "All objects need a `nango` secret; filters push down into Nango's query parameters.";

export const AGENT_TEST_TASKS = [
  { name: "crm_providers", prompt: "Which providers in the Nango catalog are in the crm category?" },
  {
    name: "unconfigured_integrations",
    prompt: "Which Nango integrations are missing credential fields, and which fields?",
  },
  { name: "broken_connections", prompt: "Which Nango connections have an auth error?" },
  { name: "org_connections", prompt: "List the connection ids that belong to organization org_acme." },
  { name: "token_expiry", prompt: "When does the access token of connection conn-ada-github expire?" },
  { name: "failing_syncs", prompt: "Which syncs are in the ERROR state, and on which connections?" },
  {
    name: "open_issues",
    prompt:
      "Using the GithubIssue records synced for conn-ada-github on github-prod, list the titles of open issues that are not deleted.",
  },
  { name: "deleted_records", prompt: "Which GithubIssue records on conn-ada-github were deleted, and when?" },
  {
    name: "proxy_repos",
    prompt: "Through the Nango proxy, how many GitHub repositories can connection conn-ada-github on github-prod see?",
  },
  { name: "env_vars", prompt: "Which environment variables are defined in the Nango environment?" },
  { name: "sync_models", prompt: "Which data models does each Nango sync produce, per integration?" },
  { name: "deployed_actions", prompt: "List the Nango actions deployed for the hubspot integration." },
  { name: "production_env", prompt: "Which Nango environments are production environments?" },
];

/** Bind-only probes: each binds the function and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "connections_columns",
    description: "The connections() result columns (binds only; create a nango secret and drop LIMIT 0 for rows)",
    sql: "SELECT connection_id, provider_config_key, has_auth_error, credential_expires_at FROM nango.main.connections() LIMIT 0",
  },
  {
    name: "proxy_columns",
    description: "The proxy() result columns (binds only; create a nango secret and drop LIMIT 0 for rows)",
    sql: "SELECT page, item_index, http_status, item FROM nango.main.proxy('conn-1', 'github', '/user') LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Nango Unified API",
  "vgi.subtitle":
    "Nango integrations, connections, syncs and records as SQL, plus read-only calls to 400+ APIs through the Nango proxy.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "nango, unified api, managed oauth, auth broker, integrations, connections, syncs, records, proxy, oauth tokens, saas apis",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Nango API",
  domain: "integrations",
  "vgi.keywords": keywordsArray("nango, providers, integrations, connections, syncs, records, proxy"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};

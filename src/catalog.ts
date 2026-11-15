/**
 * Assemble the `nango` catalog: the table functions, the parameterless listings as
 * tables, and the `nango` secret type.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import { CATALOG_COMMENT, CATALOG_NAME, CATALOG_TAGS, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";
import { DEFAULT_HOST, SECRET_TYPE } from "./nango/client.ts";
import { proxy } from "./nango/proxy.ts";
import { records } from "./nango/records.ts";
import {
  actions,
  connectionSyncs,
  connections,
  environments,
  environmentVariables,
  integrations,
  providers,
  syncs,
} from "./nango/resources.ts";

export const FUNCTIONS: VgiFunction[] = [connections, records, proxy];
export const TABLES = [providers, integrations, syncs, actions, connectionSyncs, environmentVariables, environments];

const doc = (text: string) => new Map([["vgi_doc", text]]);

/** CREATE SECRET (TYPE nango, SECRET_KEY '…' [, HOST 'https://nango.example.com']). */
export const NANGO_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "Nango environment secret key, plus the API host for a self-hosted Nango",
  schema: schema(
    [
      field(
        "secret_key",
        utf8(),
        true,
        new Map([
          ["redact", "true"],
          [
            "vgi_doc",
            "Environment secret key (Environment Settings > API keys), sent as a Bearer token. An account API key works for the environments table only.",
          ],
        ]),
      ),
      field(
        "host",
        utf8(),
        true,
        doc(
          `Nango API base URL; default ${DEFAULT_HOST}. Set it for a self-hosted Nango (http:// only for localhost).`,
        ),
      ),
    ],
    new Map([["vgi_doc_url", "https://nango.dev/docs/reference/backend/http-api/authentication"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const ALL_EXAMPLES = [
  ...stampExampleQueries(FUNCTIONS),
  ...TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]),
];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [NANGO_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: "Nango providers, integrations, connections, syncs, records and the read-only proxy.",
      functions: FUNCTIONS,
      tables: TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES.slice(0, 12)) },
    },
  ],
};

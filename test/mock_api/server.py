#!/usr/bin/env python3
"""An offline replay of the Nango API, plus a fake upstream API behind its proxy (stdlib only).

The Nango side serves the hand-built environment in ``test/fixtures/nango-env.json``
(response shapes from Nango's OpenAPI spec, docs/spec.yaml in NangoHQ/nango) and
behaves like Nango where the worker depends on it:

* **Auth.** ``Authorization: Bearer test-secret-key`` (an environment secret key) for
  every route; ``GET /environments`` is account-level and needs
  ``Bearer test-account-key``. Anything else is a 401 ``{"error": {"code": ...}}``.
* **Strict parameters.** Each route accepts only its documented query parameters and
  required headers; anything unknown is a 400 ``invalid_query_params``. So a worker
  that sends a parameter Nango does not have fails loudly.
* **Secrets.** ``GET /connections/{id}`` returns credentials (access/refresh tokens)
  exactly as Nango does; ``GET /integrations/{key}?include=credentials`` would return
  the client secret. The worker must drop the former and never ask for the latter.
* **Paging.** ``/connections`` pages by ``limit`` + ``page`` (0-based);
  ``/records`` by ``limit`` + opaque ``cursor`` / ``next_cursor``, honouring
  ``modified_after``, ``filter`` (comma list of added/updated/deleted) and ``ids``.
* **Proxy.** ``GET|HEAD /proxy/<path>`` needs ``Connection-Id`` + ``Provider-Config-Key``
  naming a real connection, then forwards to the provider's ``proxy.base_url`` (or
  ``Base-Url-Override``) on the fake upstream with that connection's credential, and
  passes ``Nango-Proxy-<name>`` headers on as ``<name>``. Other methods are 405.
* **Rate limits.** ``X-RateLimit-Limit/-Remaining/-Reset`` on every response; the first
  ``GET /integrations`` answers 429 (``Retry-After: 1``) and the first ``GET /providers``
  answers 503, so the worker's retry paths always run.
* **Introspection.** ``GET /__requests?path=/records`` (no auth) returns every recorded
  request whose path starts with ``path``: ``seq``, ``server`` (``nango`` or
  ``upstream``), ``method``, ``path``, ``query`` (JSON object string), ``headers``
  (JSON: the Nango routing headers on the Nango side; the forwarded ``x-*`` headers on
  the upstream side) and ``connection`` (upstream: whose credential arrived).

The fake upstream (its own port, reached only through the proxy) checks that the
credential it received belongs to a connection of the right provider, and serves
three pagination styles: GitHub ``Link`` headers (``/github/user/repos``), HubSpot
cursors (``/hubspot/crm/v3/objects/contacts``) and Pipedrive offsets
(``/pipedrive/v1/deals``), plus ``/github/whoami``, ``/github/nested`` and
``/github/flaky`` (429 once).

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import copy
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse

HERE = Path(__file__).resolve().parent
ENV = json.loads((HERE.parent / "fixtures" / "nango-env.json").read_text())
SECRET_KEY = "test-secret-key"
ACCOUNT_KEY = "test-account-key"

LOCK = threading.Lock()
REQUESTS: list[dict] = []
ONCE: set[str] = set()
UPSTREAM_ORIGIN = ""  # set in main()


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}


def bad_params(msg: str) -> ApiError:
    return ApiError(400, "invalid_query_params", msg)


def record(server: str, method: str, path: str, query: list[tuple[str, str]], headers: dict, connection=None):
    with LOCK:
        REQUESTS.append(
            {
                "seq": len(REQUESTS) + 1,
                "server": server,
                "method": method,
                "path": path,
                "query": json.dumps(dict(query), sort_keys=True),
                "query_list": json.dumps(query),
                "headers": json.dumps(headers, sort_keys=True),
                "connection": connection,
            }
        )


def first_time(key: str) -> bool:
    with LOCK:
        if key in ONCE:
            return False
        ONCE.add(key)
        return True


def check_params(query: list[tuple[str, str]], allowed: set[str], required: set[str] = frozenset()) -> dict:
    out: dict[str, str] = {}
    for k, v in query:
        base = k.split("[", 1)[0]
        if base not in allowed:
            raise bad_params(f"Unknown query parameter '{k}'")
        out[k] = v
    for r in required:
        if r not in out:
            raise bad_params(f"Missing required query parameter '{r}'")
    return out


def find_connection(conn_id: str | None, key: str | None) -> dict:
    for c in ENV["connections"]:
        if c["connection_id"] == conn_id and c["provider_config_key"] == key:
            return c
    raise ApiError(404, "unknown_connection", f"No connection matching connection_id '{conn_id}' and key '{key}'")


def parse_bool(v: str | None, name: str) -> bool:
    if v is None:
        return False
    if v not in ("true", "false"):
        raise bad_params(f"'{name}' must be true or false")
    return v == "true"


def parse_time(v: str, name: str) -> float:
    if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$", v):
        raise bad_params(f"'{name}' must be an ISO 8601 date-time, got {v!r}")
    from datetime import datetime

    return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()


LIST_FIELDS = ("id", "connection_id", "provider", "provider_config_key", "created", "metadata", "tags", "errors", "end_user")
FULL_FIELDS = (
    "id", "connection_id", "provider_config_key", "provider", "errors", "end_user", "metadata",
    "connection_config", "tags", "created_at", "updated_at", "last_fetched_at", "credentials",
)


# ----------------------------------------------------------------------- Nango routes


def nango_route(method: str, path: str, query: list[tuple[str, str]], headers) -> tuple[int, dict, object]:
    """Return (status, extra headers, body) for one authenticated Nango request."""
    if path == "/providers":
        check_params(query, set())
        if first_time("providers-503"):
            raise ApiError(503, "server_error", "Temporarily unavailable")
        return 200, {}, {"data": ENV["providers"]}
    m = re.fullmatch(r"/providers/([^/]+)", path)
    if m:
        check_params(query, set())
        for p in ENV["providers"]:
            if p["name"] == m.group(1):
                return 200, {}, {"data": p}
        raise ApiError(404, "not_found", f"Provider '{m.group(1)}' not found")
    if path == "/integrations":
        check_params(query, set())
        if first_time("integrations-429"):
            raise ApiError(
                429, "too_many_requests", "Too many requests",
                {"Retry-After": "1", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(int(time.time()) + 1)},
            )
        return 200, {}, {"data": ENV["integrations"]}
    m = re.fullmatch(r"/integrations/([^/]+)", path)
    if m:
        check_params(query, {"include"})
        for i in ENV["integrations"]:
            if i["unique_key"] == m.group(1):
                body = dict(i)
                if "credentials" in [v for k, v in query if k.startswith("include")]:
                    body["credentials"] = ENV["integration_secrets"].get(i["unique_key"])
                return 200, {}, {"data": body}
        raise ApiError(404, "not_found", f"Integration '{m.group(1)}' not found")
    if path in ("/connections", "/connection"):
        q = check_params(
            query, {"connectionId", "search", "endUserId", "endUserOrganizationId", "tags", "limit", "page"}
        )
        rows = ENV["connections"]
        if "connectionId" in q:
            rows = [c for c in rows if c["connection_id"] == q["connectionId"]]
        if "search" in q:
            rows = [c for c in rows if q["search"].lower() in c["connection_id"].lower()]
        for k, v in q.items():
            tm = re.fullmatch(r"tags\[([^\]]+)\]", k)
            if tm:
                rows = [c for c in rows if c["tags"].get(tm.group(1).lower()) == v]
            elif k.startswith("tags"):
                raise bad_params(f"Malformed tags parameter '{k}' (expected tags[<key>]=<value>)")
        limit = int(q.get("limit", "10000"))
        page = int(q.get("page", "0"))
        if limit < 1 or limit > 10000 or page < 0:
            raise bad_params("limit must be 1..10000 and page >= 0")
        rows = rows[page * limit : (page + 1) * limit]
        return 200, {}, {"connections": [{k: c.get(k) for k in LIST_FIELDS} for c in rows]}
    m = re.fullmatch(r"/connections?/([^/]+)", path)
    if m:
        q = check_params(
            query, {"provider_config_key", "force_refresh", "refresh_token", "refresh_github_app_jwt_token"},
            {"provider_config_key"},
        )
        parse_bool(q.get("force_refresh"), "force_refresh")
        c = find_connection(m.group(1), q["provider_config_key"])
        body = {k: copy.deepcopy(c.get(k)) for k in FULL_FIELDS}
        if not parse_bool(q.get("refresh_token"), "refresh_token"):
            body["credentials"].pop("refresh_token", None)
        return 200, {}, body
    if path == "/scripts/config":
        q = check_params(query, {"format"})
        if q.get("format", "nango") != "nango":
            raise bad_params("only format=nango is replayed")
        return 200, {}, ENV["scripts_config"]
    if path == "/records":
        return records_route(query, headers)
    if path == "/sync/status":
        q = check_params(query, {"provider_config_key", "syncs", "connection_id"}, {"provider_config_key", "syncs"})
        key = q["provider_config_key"]
        if not any(i["unique_key"] == key for i in ENV["integrations"]):
            raise ApiError(404, "unknown_provider_config", f"Integration '{key}' not found")
        names = None if q["syncs"] == "*" else set(q["syncs"].split(","))
        rows = [
            {k: v for k, v in s.items() if k != "provider_config_key"}
            for s in ENV["sync_status"]
            if s["provider_config_key"] == key
            and (names is None or s["name"] in names)
            and ("connection_id" not in q or s["connection_id"] == q["connection_id"])
        ]
        if "connection_id" in q:
            find_connection(q["connection_id"], key)
        return 200, {}, {"syncs": rows}
    if path == "/environment-variables":
        check_params(query, set())
        return 200, {}, ENV["environment_variables"]
    raise ApiError(404, "not_found", f"Unknown route GET {path}")


def records_route(query, headers) -> tuple[int, dict, object]:
    q = check_params(query, {"model", "cursor", "limit", "filter", "modified_after", "delta", "ids", "variant"}, {"model"})
    conn = find_connection(headers.get("Connection-Id"), headers.get("Provider-Config-Key"))
    rows = ENV["records"].get(f"{conn['provider_config_key']}|{conn['connection_id']}|{q['model']}", [])
    rows = [dict(r, _nango_metadata=dict(r["_nango_metadata"])) for r in rows]
    for i, r in enumerate(rows):
        r["_nango_metadata"]["cursor"] = base64.b64encode(f"{r['_nango_metadata']['last_modified_at']}||{i}".encode()).decode()
    if "modified_after" in q:
        t = parse_time(q["modified_after"], "modified_after")
        rows = [r for r in rows if parse_time(r["_nango_metadata"]["last_modified_at"], "x") > t]
    if "filter" in q:
        wanted = set(q["filter"].split(","))
        if not wanted <= {"added", "updated", "deleted"}:
            raise bad_params("filter must be a comma list of added, updated, deleted")
        rows = [r for r in rows if r["_nango_metadata"]["last_action"].lower() in wanted]
    ids = [v for k, v in query if k in ("ids", "ids[]")]
    if ids:
        if len(ids) > 100:
            raise bad_params("ids accepts at most 100 values")
        rows = [r for r in rows if r["id"] in ids]
    limit = int(q.get("limit", "100"))
    if limit < 1 or limit > 10000:
        raise bad_params("limit must be 1..10000")
    start = 0
    if "cursor" in q:
        try:
            start = int(base64.b64decode(q["cursor"]).decode().split("||")[1]) + 1
        except Exception as err:  # noqa: BLE001 - any malformed cursor is a 400
            raise bad_params("invalid cursor") from err
        rows = [r for r in rows if int(base64.b64decode(r["_nango_metadata"]["cursor"]).decode().split("||")[1]) >= start]
    page = rows[:limit]
    nxt = page[-1]["_nango_metadata"]["cursor"] if len(rows) > limit else None
    return 200, {}, {"records": page, "next_cursor": nxt}


def proxy_forward(method: str, path: str, query, headers) -> tuple[int, dict, bytes]:
    conn = find_connection(headers.get("Connection-Id"), headers.get("Provider-Config-Key"))
    provider = next(p for p in ENV["providers"] if p["name"] == conn["provider"])
    base = headers.get("Base-Url-Override") or provider["proxy"]["base_url"]
    if not base.startswith(UPSTREAM_ORIGIN):
        raise ApiError(400, "invalid_base_url", f"base url {base} is not reachable from the replay")
    url = base.rstrip("/") + "/" + path.lstrip("/")
    if query:
        url += "?" + urlencode(query)
    fwd = {k[len("Nango-Proxy-") :]: v for k, v in headers.items() if k.lower().startswith("nango-proxy-")}
    cred = conn["credentials"]
    if cred["type"] == "API_KEY":
        fwd["X-Api-Key"] = cred["apiKey"]
    else:
        fwd["Authorization"] = f"Bearer {cred['access_token']}"
    req = urllib.request.Request(url, method=method, headers=fwd)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:  # noqa: S310 - loopback upstream only
            return res.status, pass_headers(res.headers), res.read()
    except urllib.error.HTTPError as err:
        return err.code, pass_headers(err.headers), err.read()


def pass_headers(h) -> dict:
    return {k: v for k, v in h.items() if k.lower() in ("link", "content-type", "retry-after", "x-total-count")}


# ------------------------------------------------------------------- fake upstream API

TOKENS = {}
for _c in ENV["connections"]:
    _cred = _c["credentials"]
    TOKENS[_cred.get("access_token") or _cred.get("apiKey")] = _c


def upstream_route(method: str, path: str, query, headers) -> tuple[int, dict, object]:
    auth = headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else headers.get("X-Api-Key")
    conn = TOKENS.get(token or "")
    provider = path.strip("/").split("/", 1)[0]
    if not conn or conn["provider"] != provider:
        raise ApiError(401, "bad_credentials", "upstream: credential missing or for another provider")
    forwarded = {k.lower(): v for k, v in headers.items() if k.lower().startswith("x-") and k.lower() != "x-api-key"}
    record("upstream", method, path, query, forwarded, conn["connection_id"])
    up = ENV["upstream"]
    if path == "/github/user/repos":
        q = check_params(query, {"per_page", "page", "visibility"})
        per, page = int(q.get("per_page", "30")), int(q.get("page", "1"))
        rows = [r for r in up["github_repos"] if q.get("visibility") in (None, "all") or (r["private"] == (q["visibility"] == "private"))]
        chunk = rows[(page - 1) * per : page * per]
        extra = {}
        if page * per < len(rows):
            nq = dict(q, page=str(page + 1), per_page=str(per))
            extra["Link"] = f'<{UPSTREAM_ORIGIN}/github/user/repos?{urlencode(nq)}>; rel="next"'
        return 200, extra, chunk
    if path == "/github/whoami":
        check_params(query, set())
        return 200, {}, {"login": conn["connection_id"].split("-")[1], "connection_id": conn["connection_id"], "headers": forwarded}
    if path == "/github/nested":
        check_params(query, set())
        return 200, {}, {"data": {"items": [{"n": 1}, {"n": 2}, {"n": 3}]}, "meta": {"total": 3}}
    if path == "/github/flaky":
        check_params(query, set())
        if first_time("upstream-flaky"):
            raise ApiError(429, "rate_limited", "secondary rate limit", {"Retry-After": "1"})
        return 200, {}, [{"ok": True}]
    if path == "/hubspot/crm/v3/objects/contacts":
        q = check_params(query, {"limit", "after", "archived"})
        limit, after = int(q.get("limit", "10")), int(q.get("after", "0"))
        rows = up["hubspot_contacts"][after : after + limit]
        body: dict = {"results": rows}
        if after + limit < len(up["hubspot_contacts"]):
            body["paging"] = {"next": {"after": str(after + limit), "link": "unused"}}
        return 200, {}, body
    if path == "/pipedrive/v1/deals":
        q = check_params(query, {"start", "limit", "status"})
        start, limit = int(q.get("start", "0")), int(q.get("limit", "100"))
        rows = [d for d in up["pipedrive_deals"] if q.get("status") in (None, d["status"])]
        chunk = rows[start : start + limit]
        more = start + limit < len(rows)
        return 200, {}, {
            "success": True,
            "data": chunk,
            "additional_data": {"pagination": {"start": start, "limit": limit, "more_items_in_collection": more}},
        }
    raise ApiError(404, "not_found", f"upstream: no route {path}")


# ------------------------------------------------------------------------- HTTP plumbing


class Base(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        pass

    def send_json(self, status: int, body, headers: dict | None = None, head: bool = False) -> None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        sent = {k.lower() for k in (headers or {})}
        if "content-type" not in sent:
            self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0" if head else str(len(data)))
        self.end_headers()
        if not head:
            self.wfile.write(data)


class NangoHandler(Base):
    def handle_any(self, method: str) -> None:
        u = urlparse(self.path)
        query = parse_qsl(u.query, keep_blank_values=True)
        path = u.path
        rl = {"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "99", "X-RateLimit-Reset": str(int(time.time()) + 60)}
        if path == "/__requests":
            prefix = dict(query).get("path", "")
            with LOCK:
                rows = [r for r in REQUESTS if r["path"].startswith(prefix)]
            self.send_json(200, rows)
            return
        if path == "/health":
            self.send_json(200, {"status": "ok"})
            return
        try:
            auth = self.headers.get("Authorization", "")
            key = auth[7:] if auth.startswith("Bearer ") else ""
            routing = {
                k.lower(): v
                for k, v in self.headers.items()
                if k.lower() in ("connection-id", "provider-config-key", "base-url-override", "retries")
                or k.lower().startswith("nango-proxy-")
            }
            record("nango", method, path, query, routing)
            if key not in (SECRET_KEY, ACCOUNT_KEY):
                raise ApiError(401, "unknown_account", "Authentication failed. The provided secret key is invalid.")
            if path == "/environments":
                if key != ACCOUNT_KEY:
                    raise ApiError(401, "invalid_account_key", "This endpoint requires an account API key.")
                q = check_params(query, {"name"})
                rows = [e for e in ENV["environments"] if q.get("name") in (None, e["name"])]
                self.send_json(200, {"data": rows}, rl)
                return
            if key != SECRET_KEY:
                raise ApiError(401, "invalid_secret_key", "An account API key cannot call environment endpoints.")
            if path.startswith("/proxy/"):
                status, hdrs, body = proxy_forward(method, path[len("/proxy") :], query, self.headers)
                self.send_json(status, body, {**rl, **hdrs}, head=method == "HEAD")
                return
            if method != "GET":
                raise ApiError(405, "method_not_allowed", f"{method} is not replayed")
            status, hdrs, body = nango_route(method, path, query, self.headers)
            self.send_json(status, body, {**rl, **hdrs})
        except ApiError as err:
            self.send_json(err.status, {"error": {"code": err.code, "message": err.message}}, {**rl, **err.headers})

    def do_GET(self) -> None:  # noqa: N802 - stdlib signature
        self.handle_any("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self.handle_any("HEAD")

    def do_POST(self) -> None:  # noqa: N802
        self.handle_any("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self.handle_any("PUT")

    def do_PATCH(self) -> None:  # noqa: N802
        self.handle_any("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self.handle_any("DELETE")


class UpstreamHandler(Base):
    def handle_any(self, method: str) -> None:
        u = urlparse(self.path)
        query = parse_qsl(u.query, keep_blank_values=True)
        try:
            if method not in ("GET", "HEAD"):
                raise ApiError(405, "method_not_allowed", "upstream is read-only")
            status, hdrs, body = upstream_route(method, u.path, query, self.headers)
            self.send_json(status, body, hdrs, head=method == "HEAD")
        except ApiError as err:
            self.send_json(err.status, {"message": err.message}, err.headers, head=method == "HEAD")

    def do_GET(self) -> None:  # noqa: N802
        self.handle_any("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self.handle_any("HEAD")

    def do_POST(self) -> None:  # noqa: N802
        self.handle_any("POST")


def main() -> None:
    global UPSTREAM_ORIGIN
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
    UPSTREAM_ORIGIN = f"http://127.0.0.1:{upstream.server_address[1]}"
    for p in ENV["providers"]:
        p["proxy"]["base_url"] = f"{UPSTREAM_ORIGIN}/{p['name']}"
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), NangoHandler)
    print(f"PORT:{server.server_address[1]}", flush=True)
    print(f"upstream at {UPSTREAM_ORIGIN}", file=sys.stderr, flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()

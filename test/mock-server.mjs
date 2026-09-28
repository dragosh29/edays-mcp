// Local stand-in for https://YOUR-SYSTEM.e-days.co.uk: the OAuth 2.0 client-credentials token endpoint
// (POST /token) and the API V2 endpoints this server uses, serving the fixtures with the documented
// page/pagesize paging and edays-pagination-* headers.
import http from "node:http";
import * as fx from "./fixtures.mjs";

// Obviously fake, low-entropy values. Never the example credentials printed on the documentation
// page: secret scanners flag those in a public repository.
export const CLIENT_ID = "edays-test-client-not-real";
export const CLIENT_SECRET = "edays-test-secret-not-real";

// Error bodies are not documented anywhere on the page. The token endpoint answers the OAuth 2.0
// error shape; the 401 for a missing or bad bearer token uses the ASP.NET Web API default message (the
// ".issued"/".expires" fields of the documented token response are that framework's); the other errors
// use the {"StatusCode", "Message"} pair shown in the bulk-user PATCH example.
const apiError = (StatusCode, Message) => ({ StatusCode, Message });

export function startMock() {
  const requests = [];
  const tokens = new Set();
  let issued = 0;
  // "array" is the documented example (a one-element array around the token object); "object" is the
  // usual OAuth 2.0 shape.
  let tokenShape = "array";
  // expires_in of issued tokens; 3599 as in the documented example. Lowered by a check to prove the
  // client refreshes a token before it expires.
  let tokenTtl = 3599;
  // Whether POST /api/v2/absences answers 201 with the created record (default) or 201 with no body:
  // the documentation says only "Returns a 200 or 201 response if successful".
  let postReturnsRecord = true;
  // Injected failures: { method, path, status, times, headers, body, text }. Each matching request
  // consumes one "time" and gets that status instead of the normal answer (`body` as JSON, `text` as
  // text/html, neither as a generic HTML gateway page). They apply to POST /token as well. The suite
  // starts with a single 429 on GET /api/v2/absencetypes so the retry path is exercised by the schema
  // check and the MCP run alike.
  const failure429 = () => ({ method: "GET", path: "/api/v2/absencetypes", status: 429, times: 1, headers: { "Retry-After": "1" }, body: apiError(429, "Too many requests.") });
  let failures = [failure429()];
  // GET /api/v2/users is not marked as paged in the documentation and answers everything in one go by
  // default. Set to a page size to make it page like the documented "/usergroups" endpoint does (with
  // the edays-pagination-* headers), which the server must cope with.
  let usersPageSize = 0;
  // When true, the paged absence endpoints echo the requested pagesize in edays-pagination-page-size
  // while still serving at most 4 records: an undocumented cap that a client reading only the headers
  // would mistake for the end of the list.
  let echoRequestedPageSize = false;
  const created = []; // absences booked through POST, served alongside the fixtures
  const overrides = new Map(); // PUT changes and DELETEs, by lower-cased absence id

  const allAbsences = () =>
    [...fx.absences, ...created]
      .map((a) => (overrides.has(a.Id.toLowerCase()) ? overrides.get(a.Id.toLowerCase()) : a))
      .filter((a) => a !== null);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const contentType = req.headers["content-type"] ?? "";
    let body;
    if (raw) body = /^application\/x-www-form-urlencoded/.test(contentType) ? Object.fromEntries(new URLSearchParams(raw)) : /^application\/json/.test(contentType) ? JSON.parse(raw) : raw;
    // Query keys are recorded exactly as sent; the lookup below is case-insensitive like ASP.NET's.
    const query = Object.fromEntries(url.searchParams);
    const q = (name) => {
      for (const [k, v] of url.searchParams) if (k.toLowerCase() === name.toLowerCase()) return v;
      return null;
    };
    requests.push({ method: req.method, path, rawPath: url.pathname, query, auth: req.headers.authorization, contentType, body, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { ...(json === undefined ? {} : { "Content-Type": "application/json" }), ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const notFound = () => send(404, apiError(404, "No HTTP resource was found that matches the request URI."));

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        // Gateway-style error (or any other non-JSON page): text/html, like a real 502 page.
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(failure.text ?? `<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    // ---- Authentication: POST /token, x-www-form-urlencoded client credentials ----
    if (path === "/token") {
      if (req.method !== "POST") return send(405, apiError(405, "The requested resource does not support http method '" + req.method + "'."));
      if (!/^application\/x-www-form-urlencoded/.test(contentType)) return send(400, { error: "invalid_request", error_description: "The body must be application/x-www-form-urlencoded." });
      if (body?.grant_type !== "client_credentials") return send(400, { error: "unsupported_grant_type" });
      if (body?.client_id !== CLIENT_ID || body?.client_secret !== CLIENT_SECRET) return send(400, { error: "invalid_client", error_description: "Client credentials are invalid." });
      const token = `mock-token-${++issued}-${Math.random().toString(36).slice(2)}`;
      tokens.add(token);
      const now = new Date();
      const record = { token_type: "bearer", access_token: token, expires_in: tokenTtl, ".issued": now.toUTCString(), ".expires": new Date(now.getTime() + (tokenTtl + 1) * 1000).toUTCString() };
      return send(200, tokenShape === "array" ? [record] : record);
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer || !tokens.has(bearer)) return send(401, { Message: "Authorization has been denied for this request." });

    // Paging section: "page" and "pagesize" query parameters; pagesize defaults to 50. Absence pages are
    // capped at 4 records whatever is asked, so the suite exercises several pages and pages shorter than
    // requested. The four edays-pagination-* headers describe the page.
    const paged = (items, cap = 4) => {
      const page = Math.max(1, Number(q("page") || 1));
      const requested = Number(q("pagesize") || 50);
      const pageSize = Math.min(cap, requested >= 1 ? Math.floor(requested) : 50);
      const records = items.slice((page - 1) * pageSize, page * pageSize);
      return send(200, records, {
        "edays-pagination-page": String(page),
        "edays-pagination-page-size": String(echoRequestedPageSize ? Math.max(pageSize, Math.floor(requested)) : pageSize),
        "edays-pagination-returned": String(records.length),
        "edays-pagination-total": String(items.length),
      });
    };
    // Filters documented on GET /api/v2/absences and GET /api/v2/users/{id}/absences. datestart/dateend are
    // YYYYMMDD; a record matches when it overlaps the range (the documentation does not say which end
    // of the record the range is compared with). dateCreated/dateModified formats are not documented;
    // the mock reads them as YYYYMMDD like the other two. userId is the user's GUID; groupId is taken
    // as either the group's GUID or its partner ID.
    const day = (t) => t.slice(0, 10).replace(/-/g, "");
    const filterAbsences = (items, { withSystemFilters }) => {
      const recordType = q("recordtype");
      const absenceType = q("absencetype");
      const start = q("datestart");
      const end = q("dateend");
      const userId = withSystemFilters ? q("userId") : null;
      const groupId = withSystemFilters ? q("groupId") : null;
      const createdSince = withSystemFilters ? q("dateCreated") : null;
      const modifiedSince = withSystemFilters ? q("dateModified") : null;
      const members = groupId ? fx.membersOfGroup(groupId) : null;
      return items.filter((a) => {
        const type = fx.absenceTypes.find((t) => t.Id === a.AbsenceTypeId);
        if (recordType && String(type?.RecordTypeDiscriminator) !== recordType) return false;
        if (absenceType && String(a.AbsenceTypeId) !== absenceType) return false;
        if (start && day(a.EndTime) < start) return false;
        if (end && day(a.StartTime) > end) return false;
        if (userId && a.UserId.toLowerCase() !== userId.toLowerCase()) return false;
        if (members && !members.includes(a.UserId.toLowerCase())) return false;
        if (createdSince && day(a.DateCreated) < createdSince) return false;
        if (modifiedSince && day(a.DateModified) < modifiedSince) return false;
        return true;
      });
    };

    const p = path.split("/").filter(Boolean); // ["api", "v2", ...]
    if (p[0] !== "api" || p[1] !== "v2") return notFound();
    const seg = p.slice(2);
    const m = req.method;

    // ---- Users ----
    if (seg[0] === "users") {
      if (m === "GET" && seg.length === 1) return usersPageSize ? paged(fx.users, usersPageSize) : send(200, fx.users);
      const pid = decodeURIComponent(seg[1] ?? "");
      const user = fx.userByPartnerId[pid];
      if (!user) return notFound();
      if (m === "GET" && seg.length === 2) {
        const { EdaysId, ...single } = user; // the documented single-user example carries no EdaysId
        return send(200, single);
      }
      if (m !== "GET") return send(405, apiError(405, `The requested resource does not support http method '${m}'.`));
      const sub = seg.slice(2).join("/");
      if (sub === "groups") return send(200, fx.userGroups[pid] ?? []);
      if (sub === "authorisation") return send(200, fx.authorisation[pid] ?? []);
      if (sub === "rotas") return send(200, fx.rotas[pid] ?? []);
      if (sub === "publicholidays") return send(200, fx.publicHolidays[pid] ?? []);
      if (sub === "customdays") return send(200, fx.customDays[pid] ?? []);
      if (sub === "entitlements/deducting") return send(200, fx.deducting[pid] ?? []);
      if (sub === "entitlements/summing") return send(200, fx.summing[pid] ?? []);
      if (sub === "entitlements/pots") return send(200, fx.pots);
      if (sub === "absences") {
        const mine = allAbsences().filter((a) => a.UserId.toLowerCase() === user.EdaysId.toLowerCase());
        return paged(filterAbsences(mine, { withSystemFilters: false }).map(fx.asUserAbsence));
      }
      return notFound();
    }

    // ---- Absences ----
    if (seg[0] === "absences") {
      if (seg.length === 1) {
        if (m === "GET") return paged(filterAbsences(allAbsences(), { withSystemFilters: true }));
        if (m === "POST") {
          if (!/^application\/json/.test(contentType)) return send(415, apiError(415, "The request entity's media type is not supported."));
          const b = body ?? {};
          const user = fx.users.find((u) => u.EdaysId.toLowerCase() === String(b.UserId ?? "").toLowerCase());
          const type = fx.absenceTypes.find((t) => t.Id === b.AbsenceTypeId);
          if (!user || !type || typeof b.StartTime !== "string" || typeof b.EndTime !== "string" || typeof b.Status !== "string") return send(400, apiError(400, "The request is invalid."));
          const id = fx.guid(5000 + created.length);
          const stamp = "2026-09-28 12:00";
          const record = {
            Id: id,
            UserId: user.EdaysId,
            FirstName: user.FirstName,
            LastName: user.LastName,
            PayrollNumber: user.PayrollNumber,
            EmployeeNumber: user.EmployeeNumber,
            AbsenceTypeId: b.AbsenceTypeId,
            Status: b.Status,
            StartTime: b.StartTime,
            EndTime: b.EndTime,
            DurationInDays: 1,
            DurationInMinutes: 450,
            DateCreated: stamp,
            DateModified: stamp,
            IsOpen: b.IsOpen === true,
            BookedInTimeUnit: "Days",
          };
          created.push(record);
          return send(201, postReturnsRecord ? record : undefined, { Location: `http://localhost/api/v2/absences/${id}` });
        }
        return send(405, apiError(405, `The requested resource does not support http method '${m}'.`));
      }
      if (seg.length === 2) {
        const key = seg[1].toLowerCase();
        const current = allAbsences().find((a) => a.Id.toLowerCase() === key);
        if (!current) return notFound();
        if (m === "GET") return send(200, current);
        if (m === "PUT") {
          if (!/^application\/json/.test(contentType)) return send(415, apiError(415, "The request entity's media type is not supported."));
          const b = body ?? {};
          if (typeof b.StartTime !== "string" || typeof b.EndTime !== "string" || typeof b.Status !== "string" || typeof b.AbsenceTypeId !== "number") return send(400, apiError(400, "The request is invalid."));
          overrides.set(key, { ...current, UserId: b.UserId ?? current.UserId, AbsenceTypeId: b.AbsenceTypeId, Status: b.Status, StartTime: b.StartTime, EndTime: b.EndTime, IsOpen: b.IsOpen === true, DateModified: "2026-09-28 12:05" });
          return send(204); // "PUT - Change data. Returns a 200, 201 or 204 response if successful"
        }
        if (m === "DELETE") {
          overrides.set(key, null);
          return send(204);
        }
      }
      return notFound();
    }

    // ---- Absence types, groups, lists ----
    if (seg[0] === "absencetypes" && m === "GET") {
      if (seg.length === 1) return send(200, fx.absenceTypes);
      const t = fx.absenceTypes.find((x) => String(x.Id) === seg[1]);
      return t ? send(200, t) : notFound();
    }
    if (seg[0] === "grouptypes" && m === "GET") {
      if (seg.length === 1) return send(200, fx.groupTypes);
      const gt = decodeURIComponent(seg[1]);
      if (!fx.groupTypes.some((t) => t.GroupTypePartnerId === gt)) return notFound();
      if (seg.length === 3 && seg[2] === "groups") return send(200, fx.groups[gt] ?? []);
      return notFound();
    }
    if (seg[0] === "lists" && m === "GET" && seg.length === 2) {
      const list = fx.lists[seg[1]];
      return list ? send(200, list) : notFound();
    }
    return notFound();
  });

  /** Queue a failure for the next `times` requests matching method+path (body as JSON; text as text/html; neither = a generic non-JSON gateway page). */
  const arm = ({ method, path, status, times = 1, headers, body, text }) => {
    failures.push({ method, path, status, times, headers, body, text });
  };
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  /** Invalidate every token issued so far: the next API call gets a 401 until a new token is fetched. */
  const revokeTokens = () => tokens.clear();
  const setTokenShape = (shape) => {
    tokenShape = shape;
  };
  const setPostReturnsRecord = (on) => {
    postReturnsRecord = on;
  };
  const setTokenTtl = (seconds) => {
    tokenTtl = seconds;
  };
  const tokensIssued = () => issued;
  /** 0 restores the one-response default; n makes GET /api/v2/users page at n records with the paging headers. */
  const setUsersPageSize = (n) => {
    usersPageSize = n;
  };
  const setEchoRequestedPageSize = (on) => {
    echoRequestedPageSize = on;
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, revokeTokens, setTokenShape, setPostReturnsRecord, setTokenTtl, tokensIssued, setUsersPageSize, setEchoRequestedPageSize })));
}

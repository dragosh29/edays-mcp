// End-to-end test: the schemas written from Edays' documented examples are checked against those
// examples, the fixtures and the mock against the schemas, then the built MCP server is driven over
// stdio by a real MCP client against a local mock of the API (token endpoint included).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import * as S from "./schemas.mjs";
import { startMock, CLIENT_ID, CLIENT_SECRET } from "./mock-server.mjs";
import { assembleSpec, DOC_URL } from "./extract-examples.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. The schemas match the documented examples, and the fixtures match the schemas.
// Edays publishes no OpenAPI document for API V2; spec.json holds the JSON examples and the
// "Supported HTTP Methods" lines extracted from the documentation page.
if (!existsSync(`${root}spec.json`)) {
  try {
    const r = await assembleSpec(`${root}spec.json`);
    console.log(`Extracted spec.json from ${DOC_URL}: ${r.resources} resources, ${r.examples} examples (${r.unparsable} not valid JSON on the page).`);
  } catch (err) {
    console.error(`Could not extract the Edays documentation (${err?.cause?.code ?? err.message}). Build it manually:\n  node test/extract-examples.mjs`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
// Literal names documented directly under /api/v2/users/ (not a {partnerUserId} placeholder).
const RESERVED_USER_SEGMENTS = spec.resources.map((r) => r.path).filter((p) => /^\/api\/v2\/users\/[^{/]+$/.test(p)).map((p) => p.split("/").pop());
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const compiled = new Map();
const validateWith = (schema, obj, label) => {
  if (!compiled.has(schema)) compiled.set(schema, ajv.compile(schema));
  const v = compiled.get(schema);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};
const example = (path, method, kind) => {
  const ex = spec.examples.find((e) => e.path === path && e.method === method && e.kind === kind);
  assert.ok(ex, `spec.json has no documented ${method} ${kind} example for ${path}`);
  assert.equal(ex.parse_error, undefined, `the documented ${method} ${kind} example for ${path} is not valid JSON on the page: ${ex.parse_error}`);
  return ex.json;
};

console.log("schemas vs the documented examples, fixtures vs the schemas");
await check("every schema accepts the documented example it was written from (26 examples), and the resources used here are documented with their methods", async () => {
  for (const [path, method, kind, schema] of S.DOCUMENTED_EXAMPLES) validateWith(schema, example(path, method, kind), `documented ${method} ${kind} example for ${path}`);
  assert.equal(S.DOCUMENTED_EXAMPLES.length, 26);
  const documented = (path, method) => spec.resources.some((r) => r.path === path && r.methods.includes(method));
  for (const [path, method] of [
    ["/token", "POST"],
    ["/api/v2/users", "GET"],
    ["/api/v2/users/{partnerUserId}", "GET"],
    ["/api/v2/users/{partnerUserId}/groups", "GET"],
    ["/api/v2/users/{partnerUserId}/authorisation", "GET"],
    ["/api/v2/users/{partnerUserId}/absences", "GET"],
    ["/api/v2/users/{partnerUserId}/rotas", "GET"],
    ["/api/v2/users/{partnerUserId}/publicholidays", "GET"],
    ["/api/v2/users/{partnerUserId}/customdays", "GET"],
    ["/api/v2/users/{partnerUserId}/entitlements/deducting", "GET"],
    ["/api/v2/users/{partnerUserId}/entitlements/summing", "GET"],
    ["/api/v2/users/{partnerUserId}/entitlements/pots", "GET"],
    ["/api/v2/absences", "GET"],
    ["/api/v2/absences", "POST"],
    ["/api/v2/absences/{AbsenceId}", "GET"],
    ["/api/v2/absences/{AbsenceId}", "PUT"],
    ["/api/v2/absences/{AbsenceId}", "DELETE"],
    ["/api/v2/absencetypes", "GET"],
    ["/api/v2/grouptypes", "GET"],
    ["/api/v2/grouptypes/{groupTypePartnerId}/groups", "GET"],
    ["/api/v2/lists/rotas", "GET"],
    ["/api/v2/lists/publicholidays", "GET"],
    ["/api/v2/lists/customdays", "GET"],
  ]) assert.ok(documented(path, method), `${method} ${path} is not among the documented resources`);
  const paged = spec.resources.filter((r) => r.paging).map((r) => r.path);
  assert.deepEqual(paged, ["/api/v2/users/{partnerUserId}/absences", "/api/v2/absences"], "only the two absence lists are marked as supporting paging");
  assert.deepEqual(spec.resources.filter((r) => r.methods.length === 0), [], "every documented resource has at least one method");
  assert.deepEqual(new Set(spec.resources.map((r) => r.path)).size, spec.resources.length, "no resource path is recorded twice");
  assert.deepEqual(spec.resources.filter((r) => r.methods_inferred).map((r) => [r.path, r.methods]), [["/api/v2/users/authorisation", ["PATCH"]]], "the bulk authorisation endpoint has no methods line; PATCH is read from its example");
  // Endpoints that sit directly under /api/v2/users/ where a partner ID would go. Two of them change
  // data on a GET (see the server's reserved list); the user tools must never send any of them.
  assert.deepEqual(RESERVED_USER_SEGMENTS.sort(), ["/api/v2/users/applyRotaToUsers", "/api/v2/users/authorisation", "/api/v2/users/autosetupauthorisers", "/api/v2/users/recalculateauthorisationhierarchy"].map((p) => p.split("/").pop()).sort());
  for (const [p, m] of [["autosetupauthorisers", "GET"], ["recalculateauthorisationhierarchy", "GET"]]) assert.ok(documented("/api/v2/users/" + p, m), `${p} is documented as a ${m} endpoint (it changes data)`);
  // The mock's credentials are obviously fake values, never the example client ID and secret printed
  // on the documentation page (secret scanners flag those in a public repository).
  const page = JSON.stringify(spec);
  for (const [name, value] of [["CLIENT_ID", CLIENT_ID], ["CLIENT_SECRET", CLIENT_SECRET]]) {
    assert.match(value, /^edays-test-[a-z]+-not-real$/, `${name} must be an obviously fake, low-entropy value`);
    assert.ok(!page.includes(value), `${name} must not be a value printed on the documentation page`);
  }
  // The customdays example under users is not valid JSON on the page ("{ [ \"Pattern\": 3 ] }"); the
  // server reads that endpoint like publicholidays ([{"Pattern": n}]).
  assert.match(spec.examples.find((e) => e.path === "/api/v2/users/{partnerUserId}/customdays" && e.kind === "response").parse_error, /Expected property name/);
});

await check("users, absences (both shapes), absence types, entitlements, pots, rotas, patterns, group types, groups, user groups, authorisation and lists", async () => {
  fx.users.forEach((u) => validateWith(S.UserListItem, u, `user ${u.PartnerId}`));
  fx.users.forEach(({ EdaysId, ...u }) => validateWith(S.UserSingle, u, `single user ${u.PartnerId}`));
  fx.absences.forEach((a) => validateWith(S.Absence, a, `absence ${a.Id}`));
  fx.absences.map(fx.asUserAbsence).forEach((a) => validateWith(S.UserAbsence, a, `user absence ${a.Id}`));
  fx.absenceTypes.forEach((t) => validateWith(S.AbsenceType, t, `absence type ${t.Id}`));
  Object.values(fx.deducting).flat().forEach((e) => validateWith(S.DeductingEntitlement, e, `deducting ${e.UserId}/${e.ElementId}`));
  Object.values(fx.summing).flat().forEach((e) => validateWith(S.SummingEntitlement, e, `summing ${e.EntitlementPotId}`));
  fx.pots.forEach((p) => validateWith(S.EntitlementPot, p, `pot ${p.PotId}`));
  Object.values(fx.rotas).flat().forEach((r) => validateWith(S.RotaAssignment, r, `rota ${r.Rota}`));
  [...Object.values(fx.publicHolidays), ...Object.values(fx.customDays)].flat().forEach((p) => validateWith(S.Pattern, p, `pattern ${p.Pattern}`));
  fx.groupTypes.forEach((t) => validateWith(S.GroupType, t, `group type ${t.GroupTypePartnerId}`));
  Object.values(fx.groups).flat().forEach((g) => validateWith(S.Group, g, `group ${g.GroupPartnerId}`));
  Object.values(fx.userGroups).flat().forEach((g) => validateWith(S.UserGroup, g, `user group ${g.GroupPartnerId}`));
  Object.values(fx.authorisation).flat().forEach((a) => validateWith(S.Authorisation, a, `authorisation ${a.UserPartnerId}`));
  for (const [name, items] of Object.entries(fx.lists)) items.forEach((it) => validateWith(name === "timeunits" || name === "bookingperiods" ? S.KeyValueItem : S.ValueTextItem, it, `list ${name}`));
  const guids = [...fx.users.map((u) => u.EdaysId), ...fx.absences.map((a) => a.Id), ...Object.values(fx.groups).flat().map((g) => g.Id), fx.guid(999999), fx.guid(5000)];
  assert.equal(new Set(guids.map((g) => g.toLowerCase())).size, guids.length, "every fixture GUID is distinct");
});

// 2. The mock's responses (token, lists, single records, writes, errors) match the schemas and the documented paging.
const { server: mock, port, requests, arm, arm429, disarm, revokeTokens, setTokenShape, setPostReturnsRecord, setTokenTtl, tokensIssued, setUsersPageSize, setEchoRequestedPageSize } = await startMock();
const base = `http://127.0.0.1:${port}`;
const rawToken = async (id = CLIENT_ID, secret = CLIENT_SECRET) => {
  const res = await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }).toString() });
  return { status: res.status, json: await res.json() };
};
await check("mock: the token endpoint and every endpoint used answer in the documented shapes, with the edays-pagination-* headers, 401 without a token, 404 for unknown IDs, 204 on PUT and DELETE", async () => {
  const bad = await rawToken(CLIENT_ID, "wrong");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "invalid_client");
  const tok = await rawToken();
  assert.equal(tok.status, 200);
  validateWith(S.TokenResponse, tok.json, "POST /token response (documented one-element array)");
  const token = tok.json[0].access_token;
  const raw = async (method, path, init = {}) => {
    const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) }, ...init });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
  };
  assert.equal((await fetch(`${base}/api/v2/users`)).status, 401, "no token");
  assert.equal((await fetch(`${base}/api/v2/users`, { headers: { Authorization: "Bearer nope" } })).status, 401, "unknown token");
  validateWith(S.arrayOf(S.UserListItem, 1), (await raw("GET", "/api/v2/users")).json, "GET /api/v2/users");
  validateWith(S.UserSingle, (await raw("GET", `/api/v2/users/${fx.DANA}`)).json, "GET /api/v2/users/{id}");
  validateWith(S.UserSingle, (await raw("GET", `/api/v2/users/${fx.DANA}/`)).json, "GET /api/v2/users/{id}/ (the documented URL has a trailing slash)");
  assert.equal((await raw("GET", "/api/v2/users/nobody")).status, 404);
  validateWith(S.arrayOf(S.UserGroup, 1), (await raw("GET", `/api/v2/users/${fx.DANA}/groups`)).json, "user groups");
  validateWith(S.arrayOf(S.Authorisation, 1), (await raw("GET", `/api/v2/users/${fx.DANA}/authorisation`)).json, "authorisation");
  validateWith(S.arrayOf(S.RotaAssignment, 1), (await raw("GET", `/api/v2/users/${fx.DANA}/rotas`)).json, "rotas");
  validateWith(S.arrayOf(S.Pattern, 1), (await raw("GET", `/api/v2/users/${fx.DANA}/publicholidays`)).json, "public holidays");
  validateWith(S.arrayOf(S.Pattern, 1), (await raw("GET", `/api/v2/users/${fx.DANA}/customdays`)).json, "custom days");
  validateWith(S.arrayOf(S.DeductingEntitlement, 1), (await raw("GET", `/api/v2/users/${fx.DANA}/entitlements/deducting`)).json, "deducting");
  validateWith(S.arrayOf(S.SummingEntitlement, 1), (await raw("GET", `/api/v2/users/${fx.DANA}/entitlements/summing`)).json, "summing");
  validateWith(S.arrayOf(S.EntitlementPot, 1), (await raw("GET", `/api/v2/users/${fx.DANA}/entitlements/pots`)).json, "pots");
  const page1 = await raw("GET", "/api/v2/absences?page=1&pagesize=100");
  validateWith(S.arrayOf(S.Absence, 1), page1.json, "GET /api/v2/absences");
  assert.deepEqual(["edays-pagination-page", "edays-pagination-page-size", "edays-pagination-returned", "edays-pagination-total"].map((h) => page1.headers.get(h)), ["1", "4", "4", "13"], "the mock caps absence pages at 4 records");
  const page4 = await raw("GET", "/api/v2/absences?page=4&pagesize=100");
  assert.deepEqual([page4.json.length, page4.headers.get("edays-pagination-returned")], [1, "1"]);
  const userPage = await raw("GET", `/api/v2/users/${fx.DANA}/absences?pagesize=50`);
  validateWith(S.arrayOf(S.UserAbsence, 1), userPage.json, "GET /api/v2/users/{id}/absences");
  assert.equal(userPage.json[0].PayrollNumber, undefined, "the per-user shape has no PayrollNumber");
  validateWith(S.Absence, (await raw("GET", `/api/v2/absences/${fx.A_DANA_HOLIDAY}`)).json, "GET /api/v2/absences/{id}");
  assert.equal((await raw("GET", `/api/v2/absences/${fx.guid(999999)}`)).status, 404);
  const limited = await raw("GET", "/api/v2/absencetypes"); // the mock answers the first absencetypes call with a 429
  assert.equal(limited.status, 429);
  validateWith(S.arrayOf(S.AbsenceType, 1), (await raw("GET", "/api/v2/absencetypes")).json, "absence types");
  validateWith(S.arrayOf(S.GroupType, 1), (await raw("GET", "/api/v2/grouptypes")).json, "group types");
  validateWith(S.arrayOf(S.Group, 1), (await raw("GET", "/api/v2/grouptypes/loc/groups")).json, "groups");
  for (const name of ["rotas", "publicholidays", "customdays", "recordstatus", "recordtypediscriminators"]) validateWith(S.arrayOf(S.ValueTextItem, 1), (await raw("GET", `/api/v2/lists/${name}`)).json, `lists/${name}`);
  for (const name of ["timeunits", "bookingperiods"]) validateWith(S.arrayOf(S.KeyValueItem, 1), (await raw("GET", `/api/v2/lists/${name}`)).json, `lists/${name}`);
  const booking = { UserId: fx.U_DANA, AbsenceTypeId: fx.HOLIDAY, Details: "Paris", Status: "Pending", StartTime: "2026-11-16 00:00", EndTime: "2026-11-18 00:00", IsOpen: false };
  const posted = await raw("POST", "/api/v2/absences", { body: JSON.stringify(booking) });
  assert.equal(posted.status, 201);
  validateWith(S.Absence, posted.json, "POST /api/v2/absences response (the mock's own choice; not documented)");
  const put = await raw("PUT", `/api/v2/absences/${posted.json.Id}`, { body: JSON.stringify({ ...booking, Status: "Approved" }) });
  assert.equal(put.status, 204);
  assert.equal((await raw("GET", `/api/v2/absences/${posted.json.Id}`)).json.Status, "Approved");
  assert.equal((await raw("DELETE", `/api/v2/absences/${posted.json.Id}`)).status, 204);
  assert.equal((await raw("GET", `/api/v2/absences/${posted.json.Id}`)).status, 404);
  assert.equal((await raw("POST", "/api/v2/absences", { body: JSON.stringify({ UserId: fx.U_DANA }) })).status, 400);
});
requests.length = 0; // only count what the MCP server does from here on
revokeTokens();
const tokenBase = tokensIssued(); // tokens issued by the raw checks above
const issuedSince = () => tokensIssued() - tokenBase;
const tokenNo = (n) => `Bearer mock-token-${tokenBase + n}`;
arm429();

// 3. Drive the server through MCP. `writes` is the literal EDAYS_ALLOW_WRITES value; null leaves it unset.
const connect = async ({ id = CLIENT_ID, secret = CLIENT_SECRET, writes = "true", extra = {} } = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, EDAYS_CLIENT_ID: id, EDAYS_CLIENT_SECRET: secret, EDAYS_SYSTEM: "acme", EDAYS_BASE_URL: base, ...extra };
  delete env.EDAYS_ALLOW_WRITES;
  if (writes !== null) env.EDAYS_ALLOW_WRITES = writes;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const api = (list) => list.filter((r) => r.path !== "/token");
const WRITES = ["book_absence", "cancel_absence", "update_absence"];
const READS = ["get_absence", "get_user", "get_user_entitlements", "get_user_rota", "list_absence_types", "list_absences", "list_groups", "list_public_holidays", "list_users"];
const WITHHELD = ["d.barrett@example.com", "07700 900123", "0117 496 0000", "Plymouth Road", "Sam Barrett", "07700 900456", "HR-000123", "1973-10-24", "P123", "E123", "32000"];

const client = await connect();
console.log("mcp tools");

await check("tools/list exposes 12 tools; reads are read-only, update and cancel destructive, book not", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...WRITES, ...READS].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, READS.includes(t.name), `${t.name} readOnlyHint`);
    if (WRITES.includes(t.name)) assert.equal(t.annotations?.destructiveHint, t.name !== "book_absence", `${t.name} destructiveHint`);
  }
  assert.equal(requests.length, 0, "listing tools makes no API call");
});

await check("the first API call fetches a token with the documented form body, then every call sends it as a Bearer header and the token is reused", async () => {
  const { data } = await call(client, "list_absence_types");
  assert.ok(data.count >= 1);
  const tokenCalls = requests.filter((r) => r.path === "/token");
  assert.equal(tokenCalls.length, 1);
  assert.equal(requests[0].path, "/token", "the token is fetched before the first API call");
  assert.deepEqual(tokenCalls[0].body, { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }, "grant_type, client_id and client_secret, as documented");
  assert.match(tokenCalls[0].contentType, /^application\/x-www-form-urlencoded/, "n.b. use x-www-form-urlencoded body");
  assert.equal(tokenCalls[0].auth, undefined, "no Authorization header on the token request");
  await call(client, "list_public_holidays");
  await call(client, "list_groups", { group_type_partner_id: "tea" });
  assert.equal(issuedSince(), 1, "one token serves every call while it is valid");
  for (const r of api(requests)) assert.ok(r.auth.startsWith(tokenNo(1) + "-"), `${r.method} ${r.path} must carry the issued token`);
});

await check("list_users returns every user in one call, skips leavers unless asked, filters by name or partner ID, and withholds contact and HR details by default", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_users", { max_results: 1000 });
  assert.deepEqual(since(n).map((r) => [r.method, r.path, r.query]), [["GET", "/api/v2/users", {}]], "one unpaged call, no query");
  assert.deepEqual([data.count, data.matching, data.users_on_system, data.paging], [24, 24, 25, undefined], "the leaver is skipped; no paging note when the endpoint answered in one go");
  assert.ok(!data.users.some((u) => u.partner_id === fx.LEAVER));
  const dana = data.users.find((u) => u.partner_id === fx.DANA);
  assert.deepEqual(dana, {
    partner_id: fx.DANA,
    edays_id: fx.U_DANA,
    name: "Dana Barrett",
    job_title: "Programmer",
    is_leaver: false,
    settings_template_id: "521c3811-38cc-e111-833b-00155d000918",
    settings_template_partner_id: "default-template",
    employment_start_date: "2019-04-01T00:00:00",
    continuous_start_date: "2019-04-01T00:00:00",
    fte: 1,
    hours_per_day: 7.5,
    calendar_year_start: { month: 1, day: 1 },
  });
  assert.equal(data.users.find((u) => u.partner_id === fx.PRIYA).job_title, "Sales (call [phone redacted])", "a phone number typed into a job title is redacted");
  assert.equal(data.users.find((u) => u.partner_id === fx.LEE).name, "Lee Chen ([email redacted])", "an email typed into a name is redacted");
  const text = JSON.stringify(data);
  for (const leak of [...WITHHELD, "@example.com", "@example.net", "@example.org", "07700 900111", "lee.chen"]) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  const withLeavers = await call(client, "list_users", { include_leavers: true, max_results: 1000 });
  assert.deepEqual([withLeavers.data.count, withLeavers.data.users.find((u) => u.partner_id === fx.LEAVER).is_leaver], [25, true]);
  const byName = await call(client, "list_users", { query: "barrett" });
  assert.deepEqual(byName.data.users.map((u) => u.partner_id), [fx.DANA, fx.WILLIE]);
  const byPartnerId = await call(client, "list_users", { query: "user-1", max_results: 3 });
  assert.deepEqual([byPartnerId.data.count, byPartnerId.data.matching], [3, 10]);
  assert.match(byPartnerId.data.note, /first 3 of 10/);
  const full = await call(client, "list_users", { query: "dana", include_contact_details: true });
  const d = full.data.users[0];
  assert.deepEqual(
    [d.email, d.login, d.home_phone, d.work_phone, d.home_address, d.next_of_kin, d.next_of_kin_contact_details, d.date_of_birth, d.payroll_number, d.employee_number, d.client_provided_id, d.annual_pay],
    ["d.barrett@example.com", "d.barrett@example.com", "07700 900123", "0117 496 0000", "1 Plymouth Road, Penarth CF64 3DH", "Sam Barrett", "07700 900456", "1973-10-24T00:00:00", "P123", "E123", "HR-000123", 32000],
    "returned as stored with include_contact_details",
  );
  const priya = await call(client, "list_users", { query: "shah", include_contact_details: true });
  assert.equal(priya.data.users[0].job_title, "Sales (call 07700 900111)");
});

await check("list_users follows the edays-pagination-* headers if GET /api/v2/users turns out to page, and says so", async () => {
  // The page does not mark /api/v2/users as paged, but the marker is not exhaustive (the usergroups
  // endpoint pages at 500 per its prose). With 10 per page, 25 users take three pages.
  setUsersPageSize(10);
  const n = requests.length;
  const { data } = await call(client, "list_users", { include_leavers: true, max_results: 1000 });
  assert.deepEqual(since(n).map((r) => [r.path, r.query.page]), [["/api/v2/users", undefined], ["/api/v2/users", "2"], ["/api/v2/users", "3"]], "the first call is as documented (no query); pages 2 and 3 follow with the size the API chose");
  assert.deepEqual([data.count, data.users_on_system], [25, 25], "every user, not the first page reported as the whole system");
  assert.deepEqual(data.users.map((u) => u.partner_id), fx.users.map((u) => u.PartnerId), "in order, each once");
  assert.equal(data.paging, "GET /api/v2/users answered in pages (edays-pagination-total 25); 3 pages fetched, 25 of 25 users read.");
  setUsersPageSize(0);
  const m = requests.length;
  const single = await call(client, "list_users", { include_leavers: true, max_results: 1000 });
  assert.deepEqual([since(m).length, single.data.count, single.data.paging], [1, 25, undefined]);
});

await check("get_user returns the record with groups and the authorisation hierarchy, and skips the extra calls when told to", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_user", { partner_user_id: fx.DANA });
  assert.deepEqual(api(since(n)).map((r) => r.path).sort(), [`/api/v2/users/${fx.DANA}`, `/api/v2/users/${fx.DANA}/authorisation`, `/api/v2/users/${fx.DANA}/groups`]);
  assert.ok(api(since(n)).some((r) => r.rawPath === `/api/v2/users/${fx.DANA}/`), "the single-user URL is sent with the documented trailing slash");
  assert.deepEqual([data.user.partner_id, data.user.name, data.user.edays_id], [fx.DANA, "Dana Barrett", undefined], "the documented single-user record carries no EdaysId");
  assert.deepEqual(data.groups, [
    { group_edays_id: fx.G_ENG, group_partner_id: "eng", name: "England" },
    { group_edays_id: fx.G_NOTT, group_partner_id: "location-nottingham", name: "Nottingham" },
    { group_edays_id: fx.G_PROG, group_partner_id: "team-programming", name: "Programming" },
  ]);
  // Authoriser partner IDs are keys for get_user and are returned as stored, even one that is itself an
  // email address (a redacted key could not be looked up); the documented example has "Phil Jones".
  assert.deepEqual(data.authorisation, [{ user_partner_id: fx.DANA, step_one_authoriser: fx.WILLIE, step_one_alternates: [fx.PRIYA, "j.bloggs (j.bloggs@example.com)"], step_two_authoriser: "j.joyce", step_two_alternates: ["Phil Jones"] }]);
  assert.ok(!JSON.stringify([data.user, data.groups]).includes("@example"), "no email in the user record or group names by default");
  const m = requests.length;
  const bare = await call(client, "get_user", { partner_user_id: fx.WILLIE, include_groups: false, include_authorisers: false });
  assert.deepEqual(since(m).map((r) => r.path), [`/api/v2/users/${fx.WILLIE}`]);
  assert.deepEqual([bare.data.groups, bare.data.authorisation, bare.data.user.fte], [undefined, undefined, 0.8]);
  const contact = await call(client, "get_user", { partner_user_id: fx.DANA, include_contact_details: true, include_groups: false });
  assert.deepEqual([contact.data.user.email, contact.data.authorisation[0].step_one_alternates[1]], ["d.barrett@example.com", "j.bloggs (j.bloggs@example.com)"]);
});

await check("list_absences pages 1, 2, 3, 4 with pagesize 100 and stops at edays-pagination-total", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_absences", { max_results: 100 });
  assert.deepEqual(since(n).map((r) => [r.path, r.query.page, r.query.pagesize]), [["/api/v2/absences", "1", "100"], ["/api/v2/absences", "2", "100"], ["/api/v2/absences", "3", "100"], ["/api/v2/absences", "4", "100"]], "four pages of at most 4, no fifth call once the total is reached");
  assert.deepEqual([data.count, data.total, data.page_size, data.complete, data.next_page, data.note], [13, 13, 100, true, undefined, undefined]);
  assert.deepEqual(data.absences.map((a) => a.id), fx.absences.map((a) => a.Id));
  const a = data.absences[0];
  assert.deepEqual(a, {
    id: fx.A_DANA_HOLIDAY,
    user_id: fx.U_DANA,
    name: "Dana Barrett",
    absence_type_id: fx.HOLIDAY,
    status: "Approved",
    start: "2026-10-05 00:00",
    end: "2026-10-10 00:00",
    duration_days: 5,
    duration_minutes: 2250,
    is_open: false,
    booked_in_time_unit: "Days",
    date_created: "2026-08-20 10:15",
    date_modified: "2026-08-21 08:00",
  });
  const text = JSON.stringify(data);
  for (const leak of ["P123", "E123", "@example"]) assert.ok(!text.includes(leak), `${leak} leaked`);
});

// Follow a list tool's own continuation notes from `page` until it reports complete, collecting the ids.
const walk = async (tool, args, key) => {
  const ids = [];
  const calls = [];
  for (let page = args.page ?? 1; ; ) {
    const { data, text } = await call(client, tool, { ...args, page });
    assert.ok(data, text);
    calls.push({ data, request: requests.at(-1) });
    assert.ok(data.count <= args.max_results, `count ${data.count} exceeds max_results ${args.max_results}`);
    ids.push(...data[key].map((x) => x.id));
    if (data.complete) {
      assert.deepEqual([data.next_page, data.note], [undefined, undefined], "a complete list carries no continuation");
      return { ids, calls };
    }
    assert.equal(typeof data.next_page, "number");
    assert.match(data.note, new RegExp(`call again with page ${data.next_page} and the same max_results \\(${args.max_results}\\)`));
    page = data.next_page;
  }
};

await check("list_absences with max_results returns whole pages only, and following its notes yields every record exactly once", async () => {
  // page_size = max_results (6); the mock serves 4 per page regardless, so a 6-record cut would split a
  // page. The client stops after the whole page and points at the next one.
  const n = requests.length;
  const { ids, calls } = await walk("list_absences", { max_results: 6 }, "absences");
  assert.deepEqual(ids, fx.absences.map((a) => a.Id), "every absence once, in order, no gaps and no repeats");
  // The last continuation lands on a short page; starting there, the client cannot tell a last page
  // from a capped one and confirms the end with one more request (an empty page 5).
  assert.deepEqual(since(n).map((r) => [r.query.page, r.query.pagesize]), [["1", "6"], ["2", "6"], ["3", "6"], ["4", "6"], ["5", "6"]], "one request per tool call, pagesize = max_results, plus one to confirm the end");
  assert.deepEqual(calls.map((c) => [c.data.count, c.data.page_size, c.data.next_page, c.data.complete]), [[4, 6, 2, false], [4, 6, 3, false], [4, 6, 4, false], [1, 6, undefined, true]]);
  const fromThree = await walk("list_absences", { max_results: 6, page: 3 }, "absences");
  assert.deepEqual(fromThree.ids, fx.absences.slice(8).map((a) => a.Id));
  const twoPages = await call(client, "list_absences", { max_results: 8 });
  assert.deepEqual([twoPages.data.count, twoPages.data.next_page, requests.at(-1).query.pagesize], [8, 3, "8"], "two whole pages of 4 fit in 8; a third could not");
  const past = await call(client, "list_absences", { page: 9 });
  assert.deepEqual([past.data.count, past.data.complete], [0, true], "a page past the end is an empty, complete list");
  const exact = await call(client, "list_absences", { max_results: 13 });
  assert.deepEqual([exact.data.count, exact.data.complete, exact.data.next_page], [13, true, undefined], "max_results equal to the total fetches the last, short page too");
  const short = await call(client, "list_absences", { max_results: 12 });
  assert.deepEqual([short.data.count, short.data.complete, short.data.next_page], [12, false, 4]);
});

await check("the end of a list is judged from the records received: a page-size header that echoes the requested size while serving fewer does not end the walk early", async () => {
  // No maximum page size is documented. If a cap exists and the header still says 100, reading
  // page * page-size against the total would report 4 of 13 records as the complete list.
  setEchoRequestedPageSize(true);
  const n = requests.length;
  const { data } = await call(client, "list_absences", { max_results: 100 });
  assert.deepEqual(since(n).map((r) => [r.query.page, r.query.pagesize]), [["1", "100"], ["2", "100"], ["3", "100"], ["4", "100"]]);
  assert.deepEqual([data.count, data.total, data.complete, data.next_page], [13, 13, true, undefined], "every record, complete only once the total is reached");
  assert.deepEqual(data.absences.map((a) => a.id), fx.absences.map((a) => a.Id));
  const fromThree = await walk("list_absences", { max_results: 100, page: 3 }, "absences");
  assert.deepEqual(fromThree.ids, fx.absences.slice(8).map((a) => a.Id), "a walk from a later page ends when the pages before it plus the records received reach the total");
  const budget = await call(client, "list_absences", { max_results: 6 });
  assert.deepEqual([budget.data.count, budget.data.complete, budget.data.next_page], [4, false, 2], "whole pages only, even when the header claims a larger page");
  setEchoRequestedPageSize(false);
});

await check("list_absences passes every documented filter through exactly (datestart/dateend as YYYYMMDD, recordtype, absencetype, userId, groupId, dateCreated, dateModified) and refuses bad dates before any call", async () => {
  const window = await call(client, "list_absences", { date_from: "2026-10-05", date_to: "2026-10-14" });
  let q = requests.at(-1).query;
  assert.deepEqual([q.datestart, q.dateend, q.recordtype, q.absencetype, q.userId, q.groupId, q.dateCreated, q.dateModified], ["20261005", "20261014", undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(window.data.absences.map((a) => a.id), [fx.absences[0], fx.absences[2], fx.absences[5], fx.absences[7], fx.absences[9]].map((a) => a.Id), "records overlapping 5-14 October");
  const sick = await call(client, "list_absences", { record_type: 2, date_from: "20261001" });
  q = requests.at(-1).query;
  assert.deepEqual([q.recordtype, q.datestart], ["2", "20261001"], "YYYYMMDD input is accepted as is");
  assert.deepEqual(sick.data.absences.map((a) => a.id), [fx.absences[4].Id, fx.absences[7].Id]);
  const wfh = await call(client, "list_absences", { absence_type_id: fx.WFH });
  assert.equal(requests.at(-1).query.absencetype, "3");
  assert.deepEqual(wfh.data.absences.map((a) => a.absence_type_id), [3, 3, 3]);
  const byUser = await call(client, "list_absences", { user_id: fx.U_PRIYA });
  assert.equal(requests.at(-1).query.userId, fx.U_PRIYA);
  assert.deepEqual(byUser.data.absences.map((a) => a.name), ["Priya Shah", "Priya Shah", "Priya Shah", "Priya Shah"]);
  const byGroup = await call(client, "list_absences", { group_id: "team-programming", record_type: 1 });
  q = requests.at(-1).query;
  assert.deepEqual([q.groupId, q.recordtype], ["team-programming", "1"]);
  assert.deepEqual(new Set(byGroup.data.absences.map((a) => a.user_id)), new Set([fx.U_DANA, fx.U_WILLIE]));
  const created = await call(client, "list_absences", { created_since: "20260925", modified_since: "20260901" });
  q = requests.at(-1).query;
  assert.deepEqual([q.dateCreated, q.dateModified], ["20260925", "20260901"], "sent as given (their format is not documented)");
  assert.deepEqual(created.data.absences.map((a) => a.id), [fx.absences[2], fx.absences[3], fx.absences[4], fx.absences[7], fx.absences[10]].map((a) => a.Id));
  const before = requests.length;
  for (const [args, why] of [
    [{ date_from: "12/08/2026" }, /is not a date; give YYYY-MM-DD/],
    [{ date_to: "2026-13-45" }, /is not a date/],
    [{ date_from: "2026" }, /is not a date/],
    [{ date_from: "2026-1001" }, /is not a date/],
    [{ date_to: "202610-01" }, /is not a date/],
    [{ record_type: 3 }, /./],
    [{ absence_type_id: 0 }, /./],
    [{ user_id: "d.barrett" }, /GUID/],
  ]) {
    const bad = await client.callTool({ name: "list_absences", arguments: args });
    assert.ok(bad.isError, `${JSON.stringify(args)} must be refused`);
    assert.match(bad.content[0].text, why);
  }
  assert.equal(requests.length, before, "no request was made for a refused filter");
});

await check("list_absences with partner_user_id uses GET /api/v2/users/{id}/absences with its three documented filters and refuses the system-wide ones", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_absences", { partner_user_id: fx.DANA, record_type: 1, date_from: "2026-10-01", date_to: "2026-12-31" });
  assert.deepEqual(since(n).map((r) => [r.path, r.query]), [[`/api/v2/users/${fx.DANA}/absences`, { recordtype: "1", datestart: "20261001", dateend: "20261231", page: "1", pagesize: "100" }]]);
  assert.deepEqual(data.absences.map((a) => [a.id, a.status]), [[fx.absences[0].Id, "Approved"], [fx.absences[2].Id, "Approved"], [fx.absences[8].Id, "Cancelled"], [fx.absences[10].Id, "Pending"]]);
  assert.deepEqual([data.absences[0].booked_in_time_unit, data.absences[0].date_modified], [undefined, undefined], "the per-user shape has no BookedInTimeUnit or DateModified");
  const all = await walk("list_absences", { partner_user_id: fx.DANA, max_results: 4 }, "absences");
  assert.equal(all.ids.length, 5);
  const m = requests.length;
  const refused = await call(client, "list_absences", { partner_user_id: fx.DANA, user_id: fx.U_DANA, group_id: "eng" });
  assert.ok(refused.res.isError);
  assert.match(refused.text, /user_id, group_id cannot be combined with partner_user_id/);
  assert.equal(requests.length, m, "refused locally");
});

await check("get_absence withholds payroll and employee numbers by default and returns them on request", async () => {
  const { data } = await call(client, "get_absence", { absence_id: fx.A_WILLIE_PENDING });
  assert.equal(requests.at(-1).path, `/api/v2/absences/${fx.A_WILLIE_PENDING}`);
  assert.deepEqual([data.absence.name, data.absence.status, data.absence.duration_days, data.absence.payroll_number, data.absence.employee_number], ["Willie Barrett", "Pending", 5, undefined, undefined]);
  const full = await call(client, "get_absence", { absence_id: fx.A_WILLIE_PENDING.toUpperCase(), include_contact_details: true });
  assert.deepEqual([full.data.absence.payroll_number, full.data.absence.employee_number], [fx.userByPartnerId[fx.WILLIE].PayrollNumber, fx.userByPartnerId[fx.WILLIE].EmployeeNumber]);
});

await check("list_absence_types (after the 429 retry that waited for Retry-After) names record types 1, 2, 5 and 6 and filters by record_type", async () => {
  const tries = requests.filter((r) => r.path === "/api/v2/absencetypes");
  assert.equal(tries.length, 2, "absencetypes was retried once after the 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  const { data } = await call(client, "list_absence_types");
  assert.deepEqual(data.absence_types.map((t) => [t.id, t.name, t.record_type]), [[1, "Holiday", "Planned"], [2, "Sickness", "Unplanned"], [3, "Working from home", "Planned"], [5, "Christmas Shutdown", "Custom Day Group"], [6, "UK Public Holidays", "Public Holiday Group"]]);
  assert.deepEqual(data.absence_types[1], { id: 2, name: "Sickness", record_type_discriminator: 2, record_type: "Unplanned", can_book_own: false, can_book_reportees: true, can_book_others: false, can_view_in_calendar_own: true, can_view_in_calendar_reportees: true, can_view_in_calendar_others: false });
  const planned = await call(client, "list_absence_types", { record_type: 1 });
  assert.deepEqual(planned.data.absence_types.map((t) => t.id), [1, 3]);
});

await check("get_user_entitlements returns deducting balances with booking period and time unit names, summing balances and pots; the login only on request", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_user_entitlements", { partner_user_id: fx.DANA });
  assert.deepEqual(since(n).map((r) => r.path).sort(), [`/api/v2/users/${fx.DANA}/entitlements/deducting`, `/api/v2/users/${fx.DANA}/entitlements/pots`, `/api/v2/users/${fx.DANA}/entitlements/summing`]);
  assert.deepEqual(data.deducting[0], {
    entitlement_pot_id: 1,
    element_id: 1,
    element_name: "Annual Entitlement",
    booking_period: 2,
    booking_period_name: "Current",
    annual_entitlement: 25,
    transfers: 2,
    pending_approval: 3,
    total_booked: 6,
    taken: 0,
    untaken: 6,
    remaining: 18,
    time_unit: 0,
    time_unit_name: "Days",
    enabled: true,
    user_id: fx.U_DANA,
  });
  assert.deepEqual(data.deducting.map((e) => [e.element_name, e.booking_period_name]), [["Annual Entitlement", "Current"], ["Annual Entitlement", "MinusOne"], ["Long Service Award", "Current"]]);
  assert.deepEqual(data.summing, [{ entitlement_pot_id: 2, entitlement_name: "Sickness", year_to_date: 4, last_6_months: 2, last_3_months: 2, last_30_days: 2 }]);
  assert.deepEqual(data.pots, [{ pot_id: 1, description: "Holiday", record_type: 1, enabled: true }, { pot_id: 2, description: "Sickness", record_type: 2, enabled: true }]);
  assert.ok(!JSON.stringify(data).includes("@example"), "the login (an email here) is withheld by default");
  const withLogin = await call(client, "get_user_entitlements", { partner_user_id: fx.DANA, include_pots: false, include_contact_details: true });
  assert.deepEqual([withLogin.data.deducting[0].login, withLogin.data.pots], ["d.barrett@example.com", undefined]);
  const none = await call(client, "get_user_entitlements", { partner_user_id: fx.LEE });
  assert.deepEqual([none.data.deducting, none.data.summing], [[], []]);
});

await check("get_user_rota names rotas and patterns from the documented lists, caches the lists, and list_public_holidays returns both pattern lists", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_user_rota", { partner_user_id: fx.WILLIE });
  assert.deepEqual(data.rotas, [{ rota: 1, rota_name: "Mon/Tue/Wed/Thur/Fri", start_date: "2015-09-14T00:00:00" }, { rota: 2, rota_name: "Mon-Thu compressed (queries: [email redacted])", start_date: "2026-01-05T00:00:00" }]);
  assert.deepEqual([data.public_holiday_patterns, data.custom_day_patterns], [[{ pattern: 2, name: "Scotland Public Holidays" }], []]);
  // publicholidays and customdays were fetched (and cached for a minute) by the list_public_holidays call
  // in the token check above, so only the rota list is fetched here.
  const listCalls = since(n).filter((r) => r.path.startsWith("/api/v2/lists/")).map((r) => r.path).sort();
  assert.deepEqual(listCalls, ["/api/v2/lists/rotas"], "the pattern lists come from the cache");
  const m = requests.length;
  const dana = await call(client, "get_user_rota", { partner_user_id: fx.DANA, include_contact_details: true });
  assert.deepEqual(dana.data.rotas, [{ rota: 1, rota_name: "Mon/Tue/Wed/Thur/Fri", start_date: "2019-04-01T00:00:00" }]);
  assert.deepEqual([dana.data.public_holiday_patterns, dana.data.custom_day_patterns], [[{ pattern: 1, name: "UK Public Holidays" }], [{ pattern: 1, name: "Christmas Shutdown" }]]);
  assert.deepEqual(since(m).map((r) => r.path).sort(), [`/api/v2/users/${fx.DANA}/customdays`, `/api/v2/users/${fx.DANA}/publicholidays`, `/api/v2/users/${fx.DANA}/rotas`], "the three lists were served from the cache");
  const holidays = await call(client, "list_public_holidays");
  assert.deepEqual(holidays.data, { public_holiday_patterns: [{ value: 1, text: "UK Public Holidays" }, { value: 2, text: "Scotland Public Holidays" }], custom_day_patterns: [{ value: 1, text: "Christmas Shutdown" }] });
  const rotaOnly = await call(client, "get_user_rota", { partner_user_id: fx.LEE, include_patterns: false });
  assert.deepEqual(rotaOnly.data, { partner_user_id: fx.LEE, rotas: [] });
});

await check("list_groups returns every group type with its groups, or one type; an unknown type names the real ones", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_groups");
  assert.deepEqual(since(n).map((r) => r.path), ["/api/v2/grouptypes", "/api/v2/grouptypes/cou/groups", "/api/v2/grouptypes/loc/groups", "/api/v2/grouptypes/tea/groups"]);
  assert.deepEqual(data.group_types.map((t) => [t.partner_id, t.name, t.required_field, t.groups.map((g) => g.partner_id)]), [["cou", "Country", false, ["eng", "sco"]], ["loc", "Location", true, ["location-nottingham", "location-cardiff"]], ["tea", "Team", false, ["team-programming", "team-sales"]]]);
  assert.deepEqual(data.group_types[1].groups[1], { id: fx.guid(204), partner_id: "location-cardiff", name: "Cardiff, [postcode redacted] (front desk [phone redacted])", priority: 0, minimum_staffing_level: 1 });
  const one = await call(client, "list_groups", { group_type_partner_id: "tea", include_contact_details: true });
  assert.deepEqual([one.data.count, requests.at(-1).path], [1, "/api/v2/grouptypes/tea/groups"]);
  const asStored = await call(client, "list_groups", { group_type_partner_id: "loc", include_contact_details: true });
  assert.equal(asStored.data.group_types[0].groups[1].name, "Cardiff, CF10 1AB (front desk 029 2000 0000)");
  const unknown = await call(client, "list_groups", { group_type_partner_id: "dep" });
  assert.ok(unknown.res.isError);
  assert.match(unknown.text, /No group type with partner ID dep\. The system's group types are: cou, loc, tea\./);
});

await check("a token that stops working is refreshed once and the call retried; a token near expiry is refreshed before it expires; the token endpoint's object shape is accepted", async () => {
  revokeTokens();
  let n = requests.length;
  const { data } = await call(client, "list_absence_types");
  assert.equal(data.count, 5);
  assert.deepEqual(since(n).map((r) => [r.path, r.auth?.replace(/-[a-z0-9]+$/, "")]), [["/api/v2/absencetypes", tokenNo(1)], ["/token", undefined], ["/api/v2/absencetypes", tokenNo(2)]], "401 with the old token, a new token, the call repeated");
  assert.equal(issuedSince(), 2);
  // Tokens issued from now on expire in 61 s; the client refreshes 60 s early, so the next call after
  // a second must fetch a new one without seeing a 401.
  setTokenTtl(61);
  revokeTokens();
  await call(client, "list_absence_types"); // token 3, ttl 61 s
  assert.equal(issuedSince(), 3);
  await new Promise((r) => setTimeout(r, 1200));
  n = requests.length;
  await call(client, "list_absence_types");
  assert.deepEqual(since(n).map((r) => [r.path, r.auth?.replace(/-[a-z0-9]+$/, "")]), [["/token", undefined], ["/api/v2/absencetypes", tokenNo(4)]], "refreshed before expiry, no 401 round trip");
  setTokenTtl(3599);
  setTokenShape("object");
  revokeTokens();
  n = requests.length;
  const obj = await call(client, "list_absence_types");
  assert.ok(!obj.res.isError, obj.text);
  assert.equal(since(n).filter((r) => r.path === "/token").length, 1);
  setTokenShape("array");
  // A 401 that persists after one refresh is reported, not retried again.
  arm({ method: "GET", path: "/api/v2/users", status: 401, times: 2, body: { Message: "Authorization has been denied for this request." } });
  n = requests.length;
  const denied = await call(client, "list_users");
  assert.ok(denied.res.isError);
  assert.deepEqual(since(n).map((r) => r.path), ["/api/v2/users", "/token", "/api/v2/users"], "one refresh, one retry, then give up");
  assert.match(denied.text, /rejected the access token \(401\) for GET \/api\/v2\/users, even after fetching a fresh one\. Check that the Api Client user in Edays is still active/);
  disarm();
});

const goodBooking = { user_id: fx.U_DANA, absence_type_id: fx.HOLIDAY, start: "2026-11-16T00:00", end: "2026-11-18 00:00:00", details: "Holiday in Paris" };
const AbsenceRequestWithoutDetails = { ...S.AbsenceRequest, required: S.AbsenceRequest.required.filter((k) => k !== "Details") };

await check("book_absence posts the documented body (validated against the schema written from the POST example) with times normalised to 'YYYY-MM-DD HH:MM'", async () => {
  const n = requests.length;
  const { data } = await call(client, "book_absence", goodBooking);
  assert.equal(data.result, "booked");
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["POST /api/v2/absences"], "one request, no lookups");
  const post = requests.at(-1);
  assert.match(post.contentType, /^application\/json/);
  validateWith(S.AbsenceRequest, post.body, "POST /api/v2/absences body");
  assert.deepEqual(post.body, { UserId: fx.U_DANA, AbsenceTypeId: 1, Details: "Holiday in Paris", Status: "Pending", StartTime: "2026-11-16 00:00", EndTime: "2026-11-18 00:00", IsOpen: false });
  assert.deepEqual([data.absence.status, data.absence.start, data.absence.end, data.absence.name], ["Pending", "2026-11-16 00:00", "2026-11-18 00:00", "Dana Barrett"]);
  assert.match(data.location, /\/api\/v2\/absences\//);
  const booked = await call(client, "list_absences", { user_id: fx.U_DANA, date_from: "2026-11-16", date_to: "2026-11-18" });
  assert.deepEqual(booked.data.absences.map((a) => a.id), [data.absence.id], "the booking is listed afterwards");
  setPostReturnsRecord(false);
  const noBody = await call(client, "book_absence", { ...goodBooking, status: "Approved", is_open: true, details: undefined });
  assert.ok(!noBody.res.isError, noBody.text);
  assert.deepEqual([noBody.data.absence, noBody.data.response], [undefined, "Edays accepted the booking and returned no body; use list_absences to see the new record."]);
  assert.deepEqual([requests.at(-1).body.Details, requests.at(-1).body.Status, requests.at(-1).body.IsOpen], ["", "Approved", true], "Details is sent empty when omitted");
  setPostReturnsRecord(true);
  const before = requests.length;
  const backwards = await call(client, "book_absence", { ...goodBooking, end: "2026-11-15 09:00" });
  assert.ok(backwards.res.isError);
  assert.match(backwards.text, /Not booked\. The end \(2026-11-15 09:00\) is before the start/);
  for (const bad of [{ start: "16/11/2026 09:00" }, { start: "2026-11-16" }, { start: "2026-11-16 25:00" }, { start: "2026-11-16T09:00:00Z" }, { user_id: fx.DANA }, { status: "Booked" }]) {
    const res = await client.callTool({ name: "book_absence", arguments: { ...goodBooking, ...bad } });
    assert.ok(res.isError, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(requests.length, before, "nothing was posted for a refused booking");
});

await check("update_absence fetches the record, PUTs the documented body with the changes merged in (validated against the schema from the PUT example) and reports before and after", async () => {
  const n = requests.length;
  const { data } = await call(client, "update_absence", { absence_id: fx.A_WILLIE_PENDING, status: "Approved", details: "Approved by phone" });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), [`GET /api/v2/absences/${fx.A_WILLIE_PENDING}`, `PUT /api/v2/absences/${fx.A_WILLIE_PENDING}`, `GET /api/v2/absences/${fx.A_WILLIE_PENDING}`], "read, write (204), read back");
  const put = since(n)[1];
  validateWith(S.AbsenceRequest, put.body, "PUT /api/v2/absences/{id} body");
  assert.deepEqual(put.body, { UserId: fx.U_WILLIE, AbsenceTypeId: 1, Details: "Approved by phone", Status: "Approved", StartTime: "2026-10-19 00:00", EndTime: "2026-10-24 00:00", IsOpen: false });
  assert.deepEqual([data.result, data.before.status, data.absence.status, data.details_sent], ["updated", "Pending", "Approved", true]);
  const m = requests.length;
  const moved = await call(client, "update_absence", { absence_id: fx.A_WILLIE_PENDING, start: "2026-10-20 00:00", end: "2026-10-25T00:00", absence_type_id: fx.WFH, is_open: true });
  const put2 = since(m)[1];
  validateWith(AbsenceRequestWithoutDetails, put2.body, "PUT body without details");
  assert.equal("Details" in put2.body, false, "Details is left out when not given (GET cannot read it back)");
  assert.deepEqual([put2.body.StartTime, put2.body.EndTime, put2.body.AbsenceTypeId, put2.body.IsOpen, put2.body.Status], ["2026-10-20 00:00", "2026-10-25 00:00", 3, true, "Approved"]);
  assert.deepEqual([moved.data.absence.absence_type_id, moved.data.absence.is_open, moved.data.details_sent], [3, true, false]);
  const before = requests.length;
  const nothing = await call(client, "update_absence", { absence_id: fx.A_WILLIE_PENDING });
  assert.ok(nothing.res.isError);
  assert.match(nothing.text, /Not updated\. Give at least one change/);
  assert.equal(requests.length, before);
  const backwards = await call(client, "update_absence", { absence_id: fx.A_WILLIE_PENDING, end: "2026-10-01 00:00" });
  assert.ok(backwards.res.isError);
  assert.match(backwards.text, /Not updated\. The end \(2026-10-01 00:00\) would be before the start \(2026-10-20 00:00\)/);
  assert.equal(since(before).filter((r) => r.method === "PUT").length, 0, "no PUT for a refused change");
});

await check("cancel_absence sends the documented DELETE and the record is gone afterwards", async () => {
  const n = requests.length;
  const { data } = await call(client, "cancel_absence", { absence_id: fx.absences[8].Id });
  assert.deepEqual(since(n).map((r) => [r.method, r.path, r.body]), [["DELETE", `/api/v2/absences/${fx.absences[8].Id}`, undefined]]);
  assert.deepEqual(data, { result: "deleted", absence_id: fx.absences[8].Id });
  const gone = await call(client, "get_absence", { absence_id: fx.absences[8].Id });
  assert.ok(gone.res.isError);
  assert.match(gone.text, /Not found/);
});

await check("bad IDs are rejected before any API call; unknown IDs give a clear 404", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_user", { partner_user_id: "d.barrett/../w.barrett" }],
    ["get_user", { partner_user_id: " leading-space" }],
    ["get_user", { partner_user_id: "trailing-space " }],
    ["get_user", { partner_user_id: "" }],
    ["get_user", { partner_user_id: " " }],
    ["get_user", { partner_user_id: "x".repeat(201) }],
    ["get_user_entitlements", { partner_user_id: "a\tb" }],
    ["get_user_rota", { partner_user_id: "a\nb" }],
    ["get_absence", { absence_id: "12345" }],
    ["get_absence", { absence_id: "eebdc36d-c744-42a8-99be-001a2f2a24d" }],
    ["cancel_absence", { absence_id: "../absences" }],
    ["update_absence", { absence_id: fx.A_DANA_HOLIDAY, absence_type_id: 1.5 }],
    ["list_groups", { group_type_partner_id: "loc/groups" }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  // The four documented endpoints under /api/v2/users/ are refused as user IDs by every user tool, in
  // any letter case: two of them change data when fetched with GET.
  assert.equal(RESERVED_USER_SEGMENTS.length, 4);
  for (const name of RESERVED_USER_SEGMENTS.flatMap((s) => [s, s.toUpperCase(), s.toLowerCase()])) {
    for (const [tool, args] of [
      ["get_user", { partner_user_id: name }],
      ["get_user_entitlements", { partner_user_id: name }],
      ["get_user_rota", { partner_user_id: name }],
      ["list_absences", { partner_user_id: name }],
    ]) {
      const bad = await client.callTool({ name: tool, arguments: args });
      assert.ok(bad.isError, `${tool} should refuse the reserved name ${name}`);
      assert.match(bad.content[0].text, /are Edays API endpoints under \/api\/v2\/users\/, not users/);
    }
  }
  assert.equal(requests.length, before, "no request for invalid IDs");
  assert.ok(!requests.some((r) => RESERVED_USER_SEGMENTS.some((s) => r.path.toLowerCase() === `/api/v2/users/${s.toLowerCase()}`)), "no reserved endpoint was ever requested");
  const missingUser = await call(client, "get_user", { partner_user_id: "nobody" });
  assert.ok(missingUser.res.isError);
  assert.match(missingUser.text, /Not found: \/api\/v2\/users\/nobody\/\. Check the ID\./);
  // A partner ID with a space, as in the documented authorisation example ("Phil Jones"), is one
  // URL-encoded path segment.
  const spaced = await call(client, "get_user", { partner_user_id: "Phil Jones", include_groups: false, include_authorisers: false });
  assert.equal(requests.at(-1).rawPath, "/api/v2/users/Phil%20Jones/");
  assert.ok(spaced.res.isError);
  assert.match(spaced.text, /Not found: \/api\/v2\/users\/Phil%20Jones\/\. Check the ID\./);
  const missingAbsence = await call(client, "get_absence", { absence_id: fx.guid(999999) });
  assert.match(missingAbsence.text, /Not found: \/api\/v2\/absences\/[0-9a-f-]{36}\. Check the ID\./);
  const encoded = await call(client, "get_user", { partner_user_id: "e-days_apiclient@example.com" });
  assert.equal(requests.at(-1).path, "/api/v2/users/e-days_apiclient%40example.com", "a partner ID with @ is URL-encoded as one path segment");
  assert.ok(encoded.res.isError);
});

await check("a persistent 429 gives up after 3 attempts with the rate-limit message", async () => {
  arm429({ persistent: true });
  const n = requests.length;
  const { res, text } = await call(client, "list_absence_types");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/api/v2/absencetypes").length, 3, "exactly three attempts");
  assert.match(text, /Edays rate limit reached \(the limit is not documented\)\. Wait a minute and try again\./);
  disarm();
});

await check("a Retry-After longer than the cap makes the call give up at once; an HTTP-date and a fractional Retry-After are honoured", async () => {
  arm429({ retryAfter: "600" });
  let n = requests.length;
  const long = await call(client, "list_absence_types");
  assert.ok(long.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/api/v2/absencetypes").length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/api\/v2\/absencetypes \(HTTP 429\)/);
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  n = requests.length;
  const dated = await call(client, "list_absence_types");
  assert.ok(!dated.res.isError);
  let tries = since(n).filter((r) => r.path === "/api/v2/absencetypes");
  assert.equal(tries.length, 2);
  let gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  n = requests.length;
  const fractional = await call(client, "list_absence_types");
  assert.ok(!fractional.res.isError);
  tries = since(n).filter((r) => r.path === "/api/v2/absencetypes");
  assert.equal(tries.length, 2);
  gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("a 502 on a GET is retried (even with a non-JSON gateway body); a GET failing three times with 503 reports advice without the HTML", async () => {
  arm({ method: "GET", path: "/api/v2/grouptypes", status: 502, headers: { "Retry-After": "1" } });
  let n = requests.length;
  const { res, data } = await call(client, "list_groups", { group_type_partner_id: "cou" });
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.count, 1);
  assert.equal(since(n).filter((r) => r.path === "/api/v2/grouptypes").length, 2);
  arm({ method: "GET", path: "/api/v2/users", status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const down = await call(client, "list_users");
  assert.ok(down.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/api/v2/users").length, 3);
  assert.match(down.text, /Edays returned 503 for GET \/api\/v2\/users 3 times in a row\. The service may be unavailable; try again in a few minutes\./);
  assert.ok(!down.text.includes("<html>"), "gateway HTML should not be passed on");
  disarm();
});

await check("a 502 on POST /api/v2/absences, a 503 on PUT or a 504 on DELETE is never retried and the error says to check first; a 429 on the POST is retried once", async () => {
  arm({ method: "POST", path: "/api/v2/absences", status: 502, headers: { "Retry-After": "1" } });
  let n = requests.length;
  const { res, text } = await call(client, "book_absence", goodBooking);
  assert.ok(res.isError, "a 502 on a booking must surface as an error, not a success");
  assert.equal(since(n).filter((r) => r.method === "POST").length, 1, "exactly one POST");
  assert.match(text, /returned 502 for POST \/api\/v2\/absences\. The request was not retried because it may already have been processed: check with list_absences or get_absence before repeating it/);
  arm({ method: "PUT", path: `/api/v2/absences/${fx.A_DANA_HOLIDAY}`, status: 503 });
  n = requests.length;
  const failedPut = await call(client, "update_absence", { absence_id: fx.A_DANA_HOLIDAY, status: "Cancelled" });
  assert.ok(failedPut.res.isError);
  assert.equal(since(n).filter((r) => r.method === "PUT").length, 1, "a PUT is not retried after a 5xx either");
  assert.match(failedPut.text, /returned 503 for PUT .*not retried.*check with list_absences or get_absence/);
  arm({ method: "DELETE", path: `/api/v2/absences/${fx.A_DANA_HOLIDAY}`, status: 504, headers: { "Retry-After": "1" } });
  n = requests.length;
  const failedDelete = await call(client, "cancel_absence", { absence_id: fx.A_DANA_HOLIDAY });
  assert.ok(failedDelete.res.isError);
  assert.equal(since(n).length, 1, "a DELETE is not retried after a 5xx either");
  assert.match(failedDelete.text, /returned 504 for DELETE .*not retried/);
  assert.ok(!(await call(client, "get_absence", { absence_id: fx.A_DANA_HOLIDAY })).res.isError, "the record is still there: the failed DELETE reached nothing");
  arm({ method: "POST", path: "/api/v2/absences", status: 429, headers: { "Retry-After": "0" }, body: { StatusCode: 429, Message: "Too many requests." } });
  n = requests.length;
  const retried = await call(client, "book_absence", goodBooking);
  assert.ok(!retried.res.isError, retried.text);
  assert.equal(since(n).filter((r) => r.method === "POST").length, 2, "one retry after the 429");
  disarm();
});

await check("Edays' own error text is passed on with contact details redacted, a 403 is explained, and a 200 whose body is not JSON is an error, not an empty list", async () => {
  arm({ method: "GET", path: `/api/v2/absences/${fx.A_DANA_HOLIDAY}`, status: 400, body: { Message: "The request is invalid.", ModelState: { UserId: ["Contact d.barrett@example.com or 07700 900123, CF64 3DH."] } } });
  const echoed = await call(client, "get_absence", { absence_id: fx.A_DANA_HOLIDAY });
  assert.ok(echoed.res.isError);
  assert.match(echoed.text, /rejected GET \/api\/v2\/absences\/[0-9a-f-]+ \(400\)\. The request is invalid\. Validation errors: UserId: Contact \[email redacted\] or \[phone redacted\], \[postcode redacted\]\./);
  assert.ok(!echoed.text.includes("@example.com") && !echoed.text.includes("07700") && !echoed.text.includes("CF64"), "the API's error text leaked contact details");
  arm({ method: "GET", path: "/api/v2/users", status: 403, body: { Message: "Authorization has been denied for this request." } });
  const forbidden = await call(client, "list_users");
  assert.ok(forbidden.res.isError);
  assert.match(forbidden.text, /refused GET \/api\/v2\/users \(403 Forbidden\)\. The Api Client user's roles do not allow this operation/);
  arm({ method: "GET", path: "/api/v2/users", status: 200 }); // the mock answers with an HTML page
  const { res, text } = await call(client, "list_users");
  assert.ok(res.isError, `a non-JSON 200 must not be reported as success: ${text}`);
  assert.match(text, /returned 200 for GET \/api\/v2\/users but the body was not JSON \(starts with: "<html>.*Check EDAYS_SYSTEM \/ EDAYS_BASE_URL/);
  arm({ method: "GET", path: "/api/v2/users", status: 200, text: "<p>Contact hr@acme.com or 020 7946 0958 to log in</p>" }); // a login page with contact details
  const login = await call(client, "list_users");
  assert.ok(login.res.isError);
  assert.match(login.text, /starts with: "<p>Contact \[email redacted\] or \[phone redacted\] to/);
  assert.ok(!login.text.includes("acme.com") && !login.text.includes("7946"), "the excerpt of a non-JSON body must be redacted like every other passed-on text");
  disarm();
  const ok = await call(client, "list_users", { max_results: 1 });
  assert.ok(!ok.res.isError);
});

await check("POST /token: a 5xx is retried like a GET and reported without the gateway HTML; a 429 without Retry-After waits the 2 s fallback; a 200 without a token names the keys, never a value", async () => {
  // Fetching a token is idempotent, so a gateway error on it is retried; the client has a valid token
  // cached, so the mock revokes it to force a fresh request.
  arm({ method: "POST", path: "/token", status: 503, times: 3, headers: { "Retry-After": "0" } });
  revokeTokens();
  let n = requests.length;
  const down = await call(client, "list_absence_types");
  assert.ok(down.res.isError);
  assert.deepEqual(since(n).map((r) => r.path), ["/api/v2/absencetypes", "/token", "/token", "/token"], "401 with the revoked token, then three token attempts");
  assert.match(down.text, /returned 503 for POST http:\/\/127\.0\.0\.1:\d+\/token 3 times in a row\. The service may be unavailable; check EDAYS_SYSTEM \/ EDAYS_BASE_URL/);
  assert.ok(!down.text.includes("<html>") && !down.text.includes(CLIENT_SECRET), "no gateway HTML and no secret in the error");
  arm({ method: "POST", path: "/token", status: 502, headers: { "Retry-After": "0" } });
  n = requests.length;
  const once = await call(client, "list_absence_types");
  assert.ok(!once.res.isError, once.text);
  assert.deepEqual(since(n).map((r) => r.path), ["/token", "/token", "/api/v2/absencetypes"], "one 502, one retry, then the call");
  // A 429 on the token endpoint with no Retry-After header: the 2 s fallback applies.
  arm({ method: "POST", path: "/token", status: 429, body: { error: "temporarily_unavailable" } });
  revokeTokens();
  n = requests.length;
  const limited = await call(client, "list_absence_types");
  assert.ok(!limited.res.isError, limited.text);
  const tokenTries = since(n).filter((r) => r.path === "/token");
  assert.equal(tokenTries.length, 2);
  const gap = tokenTries[1].t - tokenTries[0].t;
  assert.ok(gap >= 2000 && gap < 2900, `without Retry-After the first retry waits 2 s (waited ${gap} ms)`);
  // A 200 whose body holds no access_token where the client looks: the error must not echo the body,
  // which may hold the real token under another key.
  arm({ method: "POST", path: "/token", status: 200, body: { data: { access_token: "SECRET-TOKEN-VALUE-abcdefghijklmnop" } } });
  revokeTokens();
  const odd = await call(client, "list_absence_types");
  assert.ok(odd.res.isError);
  assert.match(odd.text, /answered http:\/\/127\.0\.0\.1:\d+\/token with 200 but no access_token \(JSON with keys data\)\. Check EDAYS_SYSTEM \/ EDAYS_BASE_URL\./);
  assert.ok(!odd.text.includes("SECRET-TOKEN"), "no token value in the error");
  arm({ method: "POST", path: "/token", status: 200, text: "<html>Sign in with hr@acme.com</html>" });
  const html = await call(client, "list_absence_types");
  assert.ok(html.res.isError);
  assert.match(html.text, /no access_token \(a non-JSON body starting with "<html>Sign in with \[email redacted\]<\/html>"\)/);
  disarm();
  const back = await call(client, "list_absence_types");
  assert.ok(!back.res.isError, back.text);
});

await check("every request used the documented auth (form-encoded client credentials on /token, a Bearer token the mock issued on every API call) and a documented method+path", async () => {
  const templates = spec.resources.flatMap((r) => r.methods.map((m) => ({ m, re: new RegExp("^" + r.path.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  assert.ok(requests.length > 60);
  const issuedTokens = new Set();
  for (const r of requests) {
    if (r.path === "/token") {
      assert.equal(r.method, "POST");
      assert.equal(r.auth, undefined);
      assert.deepEqual(r.body, { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
      continue;
    }
    assert.match(r.auth ?? "", /^Bearer mock-token-\d+-[a-z0-9]+$/, `${r.method} ${r.path} must carry a Bearer token`);
    issuedTokens.add(r.auth);
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
    // {partnerUserId} matches any segment, so the reserved endpoint names are checked by hand.
    assert.ok(!RESERVED_USER_SEGMENTS.some((s) => r.path.toLowerCase() === `/api/v2/users/${s.toLowerCase()}`), `reserved endpoint requested as a user: ${r.path}`);
  }
  assert.ok(issuedTokens.size >= 4 && issuedTokens.size <= tokensIssued(), "tokens seen on API calls were all issued by the mock");
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/{guid}").replace(/\/users\/[^/]+/, "/users/{pid}").replace(/\/grouptypes\/[^/]+/, "/grouptypes/{gt}")}`));
  assert.deepEqual(
    [...used].sort(),
    [
      "DELETE /api/v2/absences/{guid}",
      "GET /api/v2/absences",
      "GET /api/v2/absences/{guid}",
      "GET /api/v2/absencetypes",
      "GET /api/v2/grouptypes",
      "GET /api/v2/grouptypes/{gt}/groups",
      "GET /api/v2/lists/customdays",
      "GET /api/v2/lists/publicholidays",
      "GET /api/v2/lists/rotas",
      "GET /api/v2/users",
      "GET /api/v2/users/{pid}",
      "GET /api/v2/users/{pid}/absences",
      "GET /api/v2/users/{pid}/authorisation",
      "GET /api/v2/users/{pid}/customdays",
      "GET /api/v2/users/{pid}/entitlements/deducting",
      "GET /api/v2/users/{pid}/entitlements/pots",
      "GET /api/v2/users/{pid}/entitlements/summing",
      "GET /api/v2/users/{pid}/groups",
      "GET /api/v2/users/{pid}/publicholidays",
      "GET /api/v2/users/{pid}/rotas",
      "POST /api/v2/absences",
      "POST /token",
      "PUT /api/v2/absences/{guid}",
    ],
  );
});
await client.close();

await check("writes are off when EDAYS_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect({ writes: value });
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.filter((t) => WRITES.includes(t.name)), [], `writes exposed with EDAYS_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    assert.equal(tools.length, READS.length);
    await ro.close();
  }
});

await check("wrong client credentials give an actionable error naming the variables; a bad EDAYS_SYSTEM or a missing secret stops the server at start-up; EDAYS_SYSTEM alone builds the documented base URL", async () => {
  const bad = await connect({ secret: "wrong-secret" });
  const { res, text } = await call(bad, "list_users");
  assert.ok(res.isError);
  assert.match(text, /rejected the client credentials at http:\/\/127\.0\.0\.1:\d+\/token \(400\)\. Check EDAYS_CLIENT_ID and EDAYS_CLIENT_SECRET.*Api Client.*Client credentials are invalid\./);
  assert.ok(!text.includes("wrong-secret"), "the secret must not be echoed");
  await bad.close();
  for (const extra of [{ EDAYS_SYSTEM: "acme.e-days.co.uk" }, { EDAYS_BASE_URL: "", EDAYS_SYSTEM: "acme.e-days.co.uk" }, { EDAYS_CLIENT_SECRET: "" }, { EDAYS_BASE_URL: "", EDAYS_SYSTEM: "" }]) {
    await assert.rejects(connect({ extra }), /closed|exit|EPIPE|Connection/i, `server should exit with ${JSON.stringify(extra)}`);
  }
  // Without EDAYS_BASE_URL the system name becomes https://<system>.e-days.co.uk. The server announces
  // its base URL on stderr at start-up; no request is made to that host here (no tool is called).
  const env = { ...process.env, EDAYS_CLIENT_ID: CLIENT_ID, EDAYS_CLIENT_SECRET: CLIENT_SECRET, EDAYS_SYSTEM: "Acme-Test" };
  delete env.EDAYS_BASE_URL;
  delete env.EDAYS_ALLOW_WRITES;
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "pipe" });
  let stderr = "";
  const named = new Client({ name: "e2e", version: "1.0.0" });
  await named.connect(transport);
  transport.stderr.on("data", (chunk) => (stderr += chunk));
  for (let i = 0; i < 50 && !/running against/.test(stderr); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(stderr, /Edays MCP server running against https:\/\/acme-test\.e-days\.co\.uk \(writes disabled\)\./);
  await named.close();
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} requests made against the mock (${requests.filter((r) => r.path === "/token").length} of them token requests).`);

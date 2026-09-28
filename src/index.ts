#!/usr/bin/env node
// Edays MCP server: lets Claude, ChatGPT and other MCP clients work with an Edays absence management system.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EdaysClient, EdaysError, headerInt } from "./client.js";
import * as fmt from "./format.js";

const clientId = process.env.EDAYS_CLIENT_ID?.trim();
const clientSecret = process.env.EDAYS_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("EDAYS_CLIENT_ID and EDAYS_CLIENT_SECRET must both be set. In Edays, create a dedicated user, set its account type to Api Client on the Roles tab and generate a Client ID and Client Secret there.");
  process.exit(1);
}
// The system is the subdomain of the tenant's Edays URL: https://YOUR-SYSTEM.e-days.co.uk. It is
// checked even when EDAYS_BASE_URL overrides it, so a typo never goes unnoticed.
const system = process.env.EDAYS_SYSTEM?.trim();
if (system !== undefined && system !== "" && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(system)) {
  console.error(`EDAYS_SYSTEM must be the subdomain only (letters, digits and hyphens), for example "acme" for https://acme.e-days.co.uk (got "${system}").`);
  process.exit(1);
}
const baseUrl = process.env.EDAYS_BASE_URL?.trim() || (system ? `https://${system.toLowerCase()}.e-days.co.uk` : "");
if (!baseUrl) {
  console.error("EDAYS_SYSTEM is not set. Set it to the subdomain of your Edays system (https://YOUR-SYSTEM.e-days.co.uk), or set EDAYS_BASE_URL.");
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.EDAYS_ALLOW_WRITES ?? "");
const api = new EdaysClient(clientId, clientSecret, baseUrl);

const server = new McpServer(
  { name: "edays", version: "0.1.0" },
  {
    instructions: [
      "Tools for an Edays absence management system (users, absences, absence types, entitlement balances, rotas, public holidays and custom days, groups).",
      "Users are addressed by their partner ID (partner_id, a string such as d.barrett); absences by a GUID; absence types by an integer. An absence's user_id and a user's edays_id are the same GUID.",
      "Absence statuses: Pending, Approved, Rejected, CancellationPending, Cancelled, Taken, CancellationRejected. Record types: 1 planned (holiday), 2 unplanned (sickness).",
      "Typical flow for 'who is off next week?': list_absences with date_from and date_to, then list_absence_types once to name the absence_type_id values.",
      "Typical flow for 'how much holiday does Dana have left?': list_users with query 'dana' to find the partner_id, then get_user_entitlements.",
      "Dates in filters are YYYY-MM-DD. Absence start and end times are 'YYYY-MM-DD HH:MM' in the system's local time; a day-based absence runs from midnight to midnight.",
      "Employees' email addresses, phone numbers, addresses, dates of birth, payroll and employee numbers, logins and pay are only returned when explicitly requested with include_contact_details.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// Partner IDs are free-form strings chosen by the customer (d.barrett, John.Smith, user-id-1 and
// "Phil Jones" in the examples; a login-style email is plausible). Any single path segment is
// accepted (no slash, no control characters, no leading or trailing whitespace, at most 200
// characters) and URL-encoded. Four names directly under /api/v2/users/ are documented endpoints,
// two of which change data on a GET (autosetupauthorisers adds users to the authoriser role,
// recalculateauthorisationhierarchy reassigns pending requests), so they are never sent as a user ID.
const RESERVED_USER_SEGMENTS = ["autosetupauthorisers", "recalculateauthorisationhierarchy", "authorisation", "applyRotaToUsers"];
const SEGMENT = /^[^\s/\x00-\x1f\x7f](?:[^/\x00-\x1f\x7f]{0,198}[^\s/\x00-\x1f\x7f])?$/;
const partnerId = (what: string, reserved: string[] = []) =>
  z
    .string()
    .regex(SEGMENT, `${what} partner IDs are single path segments such as d.barrett or "Phil Jones" (no slashes, no control characters, no leading or trailing spaces, at most 200 characters)`)
    .refine((v) => !reserved.some((r) => r.toLowerCase() === v.toLowerCase()), { message: `${what} partner ID refused: ${reserved.join(", ")} are Edays API endpoints under /api/v2/users/, not users` });
const userPartnerId = () => partnerId("User", RESERVED_USER_SEGMENTS);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (what: string) => z.string().regex(GUID, `${what} IDs are GUIDs such as eebdc36d-c744-42a8-99be-001a2f2a24de`);
const absenceTypeId = z.number().int().min(1).max(2147483647).describe("Absence type ID (integer, see list_absence_types)");
const seg = (id: string) => encodeURIComponent(id);

// Filters datestart/dateend are documented as YYYYMMDD. Accept YYYY-MM-DD (or YYYYMMDD, but not a mix
// of the two) and convert.
const DATE = /^(\d{4})(-?)(\d{2})\2(\d{2})$/;
const isRealDate = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const compactDate = z.string().transform((v, ctx) => {
  const m = DATE.exec(v.trim());
  if (!m || !isRealDate(Number(m[1]), Number(m[3]), Number(m[4]))) {
    ctx.addIssue({ code: "custom", message: `"${v}" is not a date; give YYYY-MM-DD (for example 2026-10-01)` });
    return z.NEVER;
  }
  return `${m[1]}${m[3]}${m[4]}`;
});
// Absence StartTime/EndTime are documented as "YYYY-MM-DD HH:MM". Accept that, or ISO 8601 with a T
// and optional seconds, and send the documented form. No time zone is documented, so none is accepted.
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const absenceTime = z.string().transform((v, ctx) => {
  const m = DATE_TIME.exec(v.trim());
  const [y, mo, d] = (m?.[1] ?? "").split("-").map(Number);
  if (!m || !isRealDate(y, mo, d) || Number(m[2]) > 23 || Number(m[3]) > 59) {
    ctx.addIssue({ code: "custom", message: `"${v}" is not a date and time; give YYYY-MM-DD HH:MM in the system's local time (for example 2026-10-01 09:00), with no time zone` });
    return z.NEVER;
  }
  return `${m[1]} ${m[2]}:${m[3]}`;
});

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof EdaysError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};
const includeContact = (what: string) => z.boolean().default(false).describe(`Include ${what}, and stop redacting email addresses, phone numbers and UK postcodes typed into names and other text`);

// The list endpoints in Lists are static lookups; cache them per process for a minute so a fan-out
// tool call does not fetch /api/v2/lists/rotas several times.
const listCache = new Map<string, { at: number; items: unknown }>();
async function documentedList(name: string): Promise<unknown> {
  const hit = listCache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.items;
  const items = await api.get(`/api/v2/lists/${name}`);
  listCache.set(name, { at: Date.now(), items });
  return items;
}

// If GET /api/v2/users turns out to page (see list_users), fetch at most this many pages of it.
const MAX_USER_PAGES = 200;

// Whole API pages are returned, so max_results is a ceiling and the continuation is a page number.
const pageNote = (r: { complete: boolean; next_page?: number }, maxResults: number) =>
  r.complete ? undefined : `More results exist; call again with page ${r.next_page} and the same max_results (${maxResults}) to continue. max_results sets the page size, so changing it would renumber the pages.`;

server.registerTool(
  "list_users",
  {
    title: "List users",
    description:
      "Employees on this Edays system with partner_id (the key other tools take), name, job title, leaver flag, settings template, start dates, FTE and hours per day. GET /api/v2/users is not marked as paged in the documentation; the whole list is fetched (following the edays-pagination-* headers page by page if the system does page it) and filtered locally: query matches part of the name or partner ID, and leavers are skipped unless asked for. Contact and HR details (email, login, phones, address, next of kin, date of birth, payroll and employee numbers, pay) only with include_contact_details.",
    inputSchema: {
      query: z.string().min(1).max(200).optional().describe("Case-insensitive fragment of the person's name or partner ID"),
      include_leavers: z.boolean().default(false).describe("Include users flagged IsLeaver"),
      max_results: z.number().int().min(1).max(5000).default(100).describe("Maximum number of users to return"),
      include_contact_details: includeContact("email, login, home and work phones and emails, address, next of kin, date of birth, payroll and employee numbers, SSO and client-provided IDs and annual pay"),
    },
    annotations: READ,
  },
  safe(async ({ query, include_leavers, max_results, include_contact_details }) => {
    // Not marked "(Supports paging)" on the page, but the marker is not exhaustive (the usergroups
    // endpoint says in prose that it pages at 500), so the paging headers are read and, if the
    // answer is one page of a larger total, the remaining pages are fetched with the same size.
    const first = await api.requestWithHeaders("GET", "/api/v2/users");
    const all: Record<string, any>[] = Array.isArray(first.data) ? first.data : [];
    const total = headerInt(first.headers.get("edays-pagination-total"));
    let pages = 1;
    if (total !== undefined && all.length > 0 && all.length < total) {
      for (let page = 2; all.length < total && pages < MAX_USER_PAGES; page++) {
        const more = await api.get("/api/v2/users", { page });
        const records: Record<string, any>[] = Array.isArray(more) ? more : [];
        if (records.length === 0) break;
        all.push(...records);
        pages++;
      }
    }
    const paging = pages > 1 || (total !== undefined && all.length < total)
      ? `GET /api/v2/users answered in pages (edays-pagination-total ${total}); ${pages} page${pages === 1 ? "" : "s"} fetched, ${all.length} of ${total} users read${total !== undefined && all.length < total ? " (the rest could not be fetched; narrow the query or report this)" : ""}.`
      : undefined;
    const q = query?.toLowerCase().trim();
    const matches = all.filter((u) => {
      if (!include_leavers && u.IsLeaver === true) return false;
      if (!q) return true;
      const name = [u.FirstName, u.LastName].filter((x) => typeof x === "string").join(" ").toLowerCase();
      return name.includes(q) || String(u.PartnerId ?? "").toLowerCase().includes(q);
    });
    return {
      count: Math.min(matches.length, max_results),
      matching: matches.length,
      users_on_system: all.length,
      note: matches.length > max_results ? `Only the first ${max_results} of ${matches.length} matching users are returned; raise max_results or narrow the query.` : undefined,
      paging,
      users: matches.slice(0, max_results).map((u) => fmt.user(u, include_contact_details)),
    };
  }),
);

server.registerTool(
  "get_user",
  {
    title: "Get a user",
    description:
      "One employee by partner ID, with the groups they belong to (team, location and so on) and their authorisation hierarchy (who approves their requests: step one and step two authorisers and alternates, as partner IDs). Contact and HR details only with include_contact_details.",
    inputSchema: {
      partner_user_id: userPartnerId().describe("The user's partner ID (partner_id from list_users)"),
      include_groups: z.boolean().default(true).describe("Also fetch the user's groups (one extra call)"),
      include_authorisers: z.boolean().default(true).describe("Also fetch the user's authorisation hierarchy (one extra call)"),
      include_contact_details: includeContact("email, login, phones, address, next of kin, date of birth, payroll and employee numbers, SSO and client-provided IDs and annual pay"),
    },
    annotations: READ,
  },
  safe(async ({ partner_user_id, include_groups, include_authorisers, include_contact_details }) => {
    const id = seg(partner_user_id);
    const [u, groups, auth] = await Promise.all([
      api.get(`/api/v2/users/${id}/`), // the documented single-user URL ends in a slash
      include_groups ? api.get(`/api/v2/users/${id}/groups`) : Promise.resolve(undefined),
      include_authorisers ? api.get(`/api/v2/users/${id}/authorisation`) : Promise.resolve(undefined),
    ]);
    return {
      user: fmt.user(u ?? {}, include_contact_details),
      groups: Array.isArray(groups) ? groups.map((g) => fmt.userGroup(g, include_contact_details)) : undefined,
      authorisation: Array.isArray(auth) ? auth.map((a) => fmt.authorisation(a)) : undefined,
    };
  }),
);

server.registerTool(
  "list_absences",
  {
    title: "List absences",
    description:
      "Absence records (holiday, sickness and other absence types) across the system or for one user, with status, start and end, duration and the absence_type_id (name it with list_absence_types). Filters are sent to the API as documented: date_from/date_to (datestart/dateend), record_type (1 planned, 2 unplanned), absence_type_id, and on the system-wide endpoint also user_id (Edays GUID), group_id, created_since and modified_since. With partner_user_id the per-user endpoint GET /api/v2/users/{id}/absences is used instead, which documents only the first three filters. Whole API pages of min(100, max_results) records are returned; the note says how to continue. Payroll and employee numbers only with include_contact_details.",
    inputSchema: {
      date_from: compactDate.optional().describe("Start of the date range, YYYY-MM-DD (sent as datestart=YYYYMMDD)"),
      date_to: compactDate.optional().describe("End of the date range, YYYY-MM-DD (sent as dateend=YYYYMMDD)"),
      partner_user_id: userPartnerId().optional().describe("Only this user's absences, via GET /api/v2/users/{partnerUserId}/absences"),
      record_type: z.union([z.literal(1), z.literal(2)]).optional().describe("1 for planned absences (holiday), 2 for unplanned (sickness); omitted returns all"),
      absence_type_id: absenceTypeId.optional(),
      user_id: guid("User").optional().describe("Only records for this Edays user GUID (the userId filter; not with partner_user_id)"),
      group_id: z.string().min(1).max(200).optional().describe("Only records whose user is in this group (the groupId filter, e.g. a location; not with partner_user_id). The documentation does not say whether this is the group's GUID or partner ID; the value is sent as given"),
      created_since: z.string().min(1).max(40).optional().describe("The dateCreated filter: 'filter out records created before' this value. Its format is not documented; the value is sent as given (the other date filters use YYYYMMDD). Not with partner_user_id"),
      modified_since: z.string().min(1).max(40).optional().describe("The dateModified filter: 'filter out records modified before' this value. Format not documented; sent as given. Not with partner_user_id"),
      max_results: z.number().int().min(1).max(1000).default(100).describe("Maximum number of records to return; also sets the API page size (up to 100)"),
      page: z.number().int().min(1).default(1).describe("1-based page to start from (for continuing a previous call)"),
      include_contact_details: includeContact("payroll and employee numbers"),
    },
    annotations: READ,
  },
  safe(async ({ date_from, date_to, partner_user_id, record_type, absence_type_id, user_id, group_id, created_since, modified_since, max_results, page, include_contact_details }) => {
    const query: Record<string, string | number | undefined> = { recordtype: record_type, absencetype: absence_type_id, datestart: date_from, dateend: date_to };
    let path = "/api/v2/absences";
    if (partner_user_id) {
      const extra = Object.entries({ user_id, group_id, created_since, modified_since }).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (extra.length) throw new EdaysError(`${extra.join(", ")} cannot be combined with partner_user_id: GET /api/v2/users/{partnerUserId}/absences documents only record_type, absence_type_id, date_from and date_to. Drop partner_user_id (and filter by user_id) or drop ${extra.join(", ")}.`);
      path = `/api/v2/users/${seg(partner_user_id)}/absences`;
    } else {
      Object.assign(query, { userId: user_id, groupId: group_id, dateCreated: created_since, dateModified: modified_since });
    }
    const r = await api.list(path, { maxItems: max_results, maxPages: 20, page, query });
    return {
      count: r.items.length,
      total: r.total,
      page_size: r.page_size,
      complete: r.complete,
      next_page: r.next_page,
      note: pageNote(r, max_results),
      absences: r.items.map((a) => fmt.absence(a, include_contact_details)),
    };
  }),
);

server.registerTool(
  "get_absence",
  {
    title: "Get an absence",
    description: "One absence record by its GUID: user, absence type, status, start and end, duration, time unit, created and modified dates. Payroll and employee numbers only with include_contact_details.",
    inputSchema: { absence_id: guid("Absence").describe("Absence ID (GUID)"), include_contact_details: includeContact("payroll and employee numbers") },
    annotations: READ,
  },
  safe(async ({ absence_id, include_contact_details }) => ({ absence: fmt.absence(await api.get(`/api/v2/absences/${absence_id}`), include_contact_details) })),
);

server.registerTool(
  "list_absence_types",
  {
    title: "List absence types",
    description:
      "The absence types configured on the system (Holiday, Sickness and so on) with their record type (1 planned, 2 unplanned) and booking and calendar-visibility flags. The API also returns Custom Day Groups (record type discriminator 5) and Public Holiday Groups (6) from the same endpoint; they are kept unless record_type filters them out.",
    inputSchema: {
      record_type: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(6)]).optional().describe("Only types with this record type discriminator: 1 planned, 2 unplanned, 5 custom day groups, 6 public holiday groups"),
      include_contact_details: includeContact("nothing extra (type names are the system's own text)"),
    },
    annotations: READ,
  },
  safe(async ({ record_type, include_contact_details }) => {
    const raw = await api.get("/api/v2/absencetypes");
    const types = (Array.isArray(raw) ? raw : []).map((t) => fmt.absenceType(t, include_contact_details)).filter((t) => record_type === undefined || t.record_type_discriminator === record_type);
    return { count: types.length, absence_types: types };
  }),
);

server.registerTool(
  "get_user_entitlements",
  {
    title: "Get a user's entitlement balances",
    description:
      "Entitlement balances for one user. Deducting entitlements (holiday and the like, which count down: annual entitlement, transfers, pending, booked, taken, untaken, remaining, per booking period and element) and summing entitlements (sickness and the like, which count up: year to date, last 6 and 3 months, last 30 days), plus the entitlement pots they belong to. Booking period and time unit numbers are named from the documented lists (Current, MinusOne, PlusOne; Days, Minutes, Hours).",
    inputSchema: {
      partner_user_id: userPartnerId().describe("The user's partner ID"),
      include_pots: z.boolean().default(true).describe("Also fetch the user's entitlement pots (one extra call)"),
      include_contact_details: includeContact("the user's login"),
    },
    annotations: READ,
  },
  safe(async ({ partner_user_id, include_pots, include_contact_details }) => {
    const id = seg(partner_user_id);
    const [deducting, summing, pots] = await Promise.all([
      api.get(`/api/v2/users/${id}/entitlements/deducting`),
      api.get(`/api/v2/users/${id}/entitlements/summing`),
      include_pots ? api.get(`/api/v2/users/${id}/entitlements/pots`) : Promise.resolve(undefined),
    ]);
    return {
      partner_user_id,
      deducting: (Array.isArray(deducting) ? deducting : []).map((e) => fmt.deductingEntitlement(e, include_contact_details)),
      summing: (Array.isArray(summing) ? summing : []).map((e) => fmt.summingEntitlement(e, include_contact_details)),
      pots: Array.isArray(pots) ? pots.map((p) => fmt.entitlementPot(p, include_contact_details)) : undefined,
    };
  }),
);

server.registerTool(
  "get_user_rota",
  {
    title: "Get a user's rota, public holidays and custom days",
    description:
      "The rota (working pattern) assignments of one user with their start dates, named from the system's rota list, and with include_patterns the public holiday and custom day patterns applied to the user, named from those lists. Up to six API calls.",
    inputSchema: {
      partner_user_id: userPartnerId().describe("The user's partner ID"),
      include_patterns: z.boolean().default(true).describe("Also fetch the user's public holiday and custom day patterns"),
      include_contact_details: includeContact("nothing extra (rota and pattern names are the system's own text)"),
    },
    annotations: READ,
  },
  safe(async ({ partner_user_id, include_patterns, include_contact_details }) => {
    const id = seg(partner_user_id);
    const [rotas, rotaNames] = await Promise.all([api.get(`/api/v2/users/${id}/rotas`), documentedList("rotas")]);
    const result: Record<string, unknown> = {
      partner_user_id,
      rotas: (Array.isArray(rotas) ? rotas : []).map((r) => fmt.rotaAssignment(r, fmt.listLookup(rotaNames, include_contact_details))),
    };
    if (include_patterns) {
      const [holidays, holidayNames, customDays, customDayNames] = await Promise.all([
        api.get(`/api/v2/users/${id}/publicholidays`),
        documentedList("publicholidays"),
        api.get(`/api/v2/users/${id}/customdays`),
        documentedList("customdays"),
      ]);
      result.public_holiday_patterns = (Array.isArray(holidays) ? holidays : []).map((p) => fmt.pattern(p, fmt.listLookup(holidayNames, include_contact_details)));
      result.custom_day_patterns = (Array.isArray(customDays) ? customDays : []).map((p) => fmt.pattern(p, fmt.listLookup(customDayNames, include_contact_details)));
    }
    return result;
  }),
);

server.registerTool(
  "list_public_holidays",
  {
    title: "List public holiday and custom day patterns",
    description:
      "The public holiday patterns held in the system (for example 'UK Public Holidays') and, with include_custom_days, the custom day patterns (for example 'Christmas Shutdown'), as id and name. The API lists the patterns only; the dates inside a pattern are not exposed by API V2.",
    inputSchema: {
      include_custom_days: z.boolean().default(true).describe("Also list custom day patterns"),
      include_contact_details: includeContact("nothing extra (pattern names are the system's own text)"),
    },
    annotations: READ,
  },
  safe(async ({ include_custom_days, include_contact_details }) => {
    const [holidays, customDays] = await Promise.all([documentedList("publicholidays"), include_custom_days ? documentedList("customdays") : Promise.resolve(undefined)]);
    const items = (v: unknown) => (Array.isArray(v) ? v.map((x) => fmt.listItem(x, include_contact_details)) : []);
    return { public_holiday_patterns: items(holidays), ...(include_custom_days ? { custom_day_patterns: items(customDays) } : {}) };
  }),
);

server.registerTool(
  "list_groups",
  {
    title: "List group types and groups",
    description:
      "The group types on the system (Country, Location, Team and so on) and the groups within each (England, Nottingham, Programming), with partner IDs. One call for the types plus one per type for its groups; give group_type_partner_id to fetch a single type.",
    inputSchema: {
      group_type_partner_id: partnerId("Group type").optional().describe("Only this group type's groups (its partner ID, e.g. loc)"),
      include_contact_details: includeContact("nothing extra (group names are the system's own text)"),
    },
    annotations: READ,
  },
  safe(async ({ group_type_partner_id, include_contact_details }) => {
    const raw = await api.get("/api/v2/grouptypes");
    const types = (Array.isArray(raw) ? raw : []).map((t) => fmt.groupType(t, include_contact_details));
    const wanted = group_type_partner_id ? types.filter((t) => t.partner_id === group_type_partner_id) : types;
    if (group_type_partner_id && wanted.length === 0) throw new EdaysError(`No group type with partner ID ${group_type_partner_id}. The system's group types are: ${types.map((t) => t.partner_id).join(", ") || "none"}.`);
    const out = [];
    for (const t of wanted) {
      const groups = t.partner_id ? await api.get(`/api/v2/grouptypes/${seg(t.partner_id)}/groups`) : [];
      out.push({ ...t, groups: (Array.isArray(groups) ? groups : []).map((g) => fmt.group(g, include_contact_details)) });
    }
    return { count: out.length, group_types: out };
  }),
);

if (allowWrites) {
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;
  // The documentation says only that POST answers 200 or 201; the body is not documented. A body that
  // looks like an absence record is formatted, anything else is passed on as is.
  const absenceResult = (body: unknown) =>
    body && typeof body === "object" && !Array.isArray(body) && "Id" in (body as Record<string, unknown>)
      ? { absence: fmt.absence(body as Record<string, unknown>, false) }
      : { response: body === undefined ? "Edays accepted the booking and returned no body; use list_absences to see the new record." : body };

  server.registerTool(
    "book_absence",
    {
      title: "Book an absence",
      description:
        "Create an absence record (POST /api/v2/absences) for a user identified by their Edays GUID (edays_id from list_users, or user_id on an absence). Times are 'YYYY-MM-DD HH:MM' in the system's local time; for a day-based absence type on a days-based rota use midnight to midnight (2026-10-13 00:00 to 2026-10-15 00:00 is two full days). Status defaults to Pending, so the request goes to the user's authoriser. The API does not document the response body, so the result is whatever it returns. If Edays answers with a gateway error (502/503/504) the booking is NOT retried, because it may already have been created: check with list_absences before calling again. Only available when EDAYS_ALLOW_WRITES=true.",
      inputSchema: {
        user_id: guid("User").describe("The user's Edays GUID (edays_id from list_users)"),
        absence_type_id: absenceTypeId,
        start: absenceTime.describe("Start, YYYY-MM-DD HH:MM (system local time)"),
        end: absenceTime.describe("End, YYYY-MM-DD HH:MM (system local time)"),
        details: z.string().max(2000).default("").describe("Free-text details, e.g. 'Holiday in Paris' (sent as Details; empty when omitted)"),
        status: z.enum(fmt.RECORD_STATUSES).default("Pending").describe("Record status to create with; Pending (the default) sends it for authorisation"),
        is_open: z.boolean().default(false).describe("Open-ended absence (no known end yet), as the documented IsOpen flag"),
      },
      annotations: WRITE,
    },
    safe(async ({ user_id, absence_type_id, start, end, details, status, is_open }) => {
      if (end < start) throw new EdaysError(`Not booked. The end (${end}) is before the start (${start}).`);
      // Body shape: the documented POST /api/v2/absences example.
      const body = { UserId: user_id, AbsenceTypeId: absence_type_id, Details: details, Status: status, StartTime: start, EndTime: end, IsOpen: is_open };
      const { data, headers } = await api.requestWithHeaders("POST", "/api/v2/absences", { body });
      const location = headers.get("location") ?? undefined;
      return { result: "booked", ...absenceResult(data), ...(location ? { location } : {}) };
    }),
  );

  server.registerTool(
    "update_absence",
    {
      title: "Update an absence",
      description:
        "Change an existing absence (PUT /api/v2/absences/{id}): its type, status (for example Approved, Rejected or Cancelled, the only documented way to approve or reject through API V2), start and end, open flag or details. The record is fetched first and the documented PUT body (UserId, AbsenceTypeId, Details, Status, StartTime, EndTime, IsOpen) is built from it plus your changes. Caution: GET does not return Details, so when details is not given the key is left out of the PUT and the stored text may be cleared; pass details to be sure. Never retried after a gateway error. Only available when EDAYS_ALLOW_WRITES=true.",
      inputSchema: {
        absence_id: guid("Absence").describe("Absence ID (GUID)"),
        absence_type_id: absenceTypeId.optional(),
        status: z.enum(fmt.RECORD_STATUSES).optional().describe("New status"),
        start: absenceTime.optional().describe("New start, YYYY-MM-DD HH:MM"),
        end: absenceTime.optional().describe("New end, YYYY-MM-DD HH:MM"),
        details: z.string().max(2000).optional().describe("Details text to store (the API cannot read the current text back)"),
        is_open: z.boolean().optional(),
        user_id: guid("User").optional().describe("Move the record to another user (Edays GUID); normally omitted"),
      },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ absence_id, absence_type_id, status, start, end, details, is_open, user_id }) => {
      const changes = { absence_type_id, status, start, end, details, is_open, user_id };
      if (Object.values(changes).every((v) => v === undefined)) throw new EdaysError("Not updated. Give at least one change (absence_type_id, status, start, end, details, is_open or user_id).");
      const current = await api.get(`/api/v2/absences/${absence_id}`);
      const body: Record<string, unknown> = {
        UserId: user_id ?? current?.UserId,
        AbsenceTypeId: absence_type_id ?? current?.AbsenceTypeId,
        ...(details !== undefined ? { Details: details } : {}),
        Status: status ?? current?.Status,
        StartTime: start ?? current?.StartTime,
        EndTime: end ?? current?.EndTime,
        IsOpen: is_open ?? current?.IsOpen ?? false,
      };
      if (typeof body.StartTime === "string" && typeof body.EndTime === "string" && body.EndTime < body.StartTime) throw new EdaysError(`Not updated. The end (${body.EndTime}) would be before the start (${body.StartTime}).`);
      const { data } = await api.requestWithHeaders("PUT", `/api/v2/absences/${absence_id}`, { body });
      const after = data && typeof data === "object" && "Id" in data ? data : await api.get(`/api/v2/absences/${absence_id}`);
      return { result: "updated", before: fmt.absence(current ?? {}, false), absence: fmt.absence(after ?? {}, false), details_sent: details !== undefined };
    }),
  );

  server.registerTool(
    "cancel_absence",
    {
      title: "Delete an absence record",
      description:
        "Remove an absence record with the documented DELETE /api/v2/absences/{id} (the API answers 204). The documentation calls this 'delete a specified absence record'; whether Edays keeps it as Cancelled or removes it outright is not documented, so to cancel while keeping the record use update_absence with status Cancelled. Cannot be undone. Only available when EDAYS_ALLOW_WRITES=true.",
      inputSchema: { absence_id: guid("Absence").describe("Absence ID (GUID)") },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ absence_id }) => {
      await api.request("DELETE", `/api/v2/absences/${absence_id}`);
      return { result: "deleted", absence_id };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Edays MCP server running against ${baseUrl} (writes ${allowWrites ? "enabled" : "disabled"}).`);

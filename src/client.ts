// Minimal Edays API V2 client used by the MCP tools.
// Docs: https://developer.e-days.co.uk (one HTML page; there is no OpenAPI document for API V2).
import { redactContacts } from "./format.js";

export class EdaysError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "EdaysError";
  }
}

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET and for POST /token (fetching a token is idempotent): repeating a POST /api/v2/absences
// could book the same absence twice.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const TOKEN_PATH = "/token";
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// Paging: "pagesize" defaults to 50 in the documentation and no maximum is documented; the paging
// example shows a page size of 500. 100 per page is this server's own choice.
export const PAGE_SIZE = 100;
// Refresh the cached token this long before the documented one-hour expiry.
const TOKEN_REFRESH_MARGIN_S = 60;

export type QueryValue = string | number | boolean | undefined;

interface TokenResponse {
  token_type?: string;
  access_token?: string;
  expires_in?: number | string;
}

export class EdaysClient {
  private readonly baseUrl: string;
  // Edays does not document a rate limit. Space requests at about four per second so a tool call
  // that fans out (a user's rotas, holidays and custom days) stays polite; 429s are retried using
  // Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;

  /**
   * `baseUrl` is the tenant's system, https://YOUR-SYSTEM.e-days.co.uk. The token endpoint is
   * {baseUrl}/token and every API call goes under {baseUrl}/api/v2/... (Authentication section).
   */
  constructor(private readonly clientId: string, private readonly clientSecret: string, baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get base(): string {
    return this.baseUrl;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * Authentication, "Requesting an authentication token": POST {base}/token with an
   * x-www-form-urlencoded body grant_type=client_credentials&client_id=...&client_secret=...; the
   * answer carries access_token and expires_in (3599 in the example, "valid for one hour"). The
   * documented example response is a one-element array around that object; a bare object (the
   * usual OAuth 2.0 shape) is accepted too. The token is cached and refreshed a minute before it
   * expires, and never written to a log or an error message: only a JSON message from the token
   * endpoint is passed on, never a raw body (a 200 without a token would start with the token).
   */
  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = this.requestToken().finally(() => {
        this.tokenRequest = undefined;
      });
    }
    return this.tokenRequest;
  }

  private async requestToken(): Promise<string> {
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret });
    const { status, json, text } = await this.send("POST", TOKEN_PATH, {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
    const record: TokenResponse | undefined = Array.isArray(json) ? json[0] : json;
    if (status === 200 && record && typeof record.access_token === "string" && record.access_token) {
      const expiresIn = Number(record.expires_in);
      const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
      this.token = { value: record.access_token, expiresAt: Date.now() + Math.max(0, ttl - TOKEN_REFRESH_MARGIN_S) * 1000 };
      return record.access_token;
    }
    this.token = undefined;
    const detail = redactContacts(describeError(json), false);
    if (status === 400 || status === 401 || status === 403) {
      throw new EdaysError(
        `Edays rejected the client credentials at ${this.baseUrl}/token (${status}). Check EDAYS_CLIENT_ID and EDAYS_CLIENT_SECRET: they are generated in Edays on the Roles tab of a user whose account type is "Api Client", and regenerating the secret replaces the old one.${detail ? " " + detail : ""}`,
        status,
      );
    }
    if (status === 200) {
      // Say what shape came back without echoing any value: the body may hold the token under a key
      // this client does not read.
      const shape = json && typeof json === "object" ? `JSON with keys ${Object.keys(record && typeof record === "object" ? record : json).join(", ") || "(none)"}` : `a non-JSON body starting with ${JSON.stringify(redactContacts(text.slice(0, 60), false) ?? "")}`;
      throw new EdaysError(`Edays answered ${this.baseUrl}/token with 200 but no access_token (${shape}). Check EDAYS_SYSTEM / EDAYS_BASE_URL.`, status);
    }
    if (RETRY_GET_ONLY.has(status)) throw new EdaysError(`Edays returned ${status} for POST ${this.baseUrl}/token ${MAX_ATTEMPTS} times in a row. The service may be unavailable; check EDAYS_SYSTEM / EDAYS_BASE_URL and try again in a few minutes.${detail ? " " + detail : ""}`, status);
    throw new EdaysError(`Edays returned ${status} for POST ${this.baseUrl}/token. Check EDAYS_SYSTEM / EDAYS_BASE_URL and try again.${detail ? " " + detail : ""}`, status);
  }

  /** One HTTP exchange with throttling and the 429 / gateway retry policy; no auth handling. */
  private async send(method: string, path: string, init: { headers: Record<string, string>; body?: string; query?: Record<string, QueryValue> }): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const shown = `${method} ${path}`;
    const gatewayRetry = method === "GET" || (method === "POST" && path === TOKEN_PATH);
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers: init.headers, body: init.body });
      } catch (err) {
        throw new EdaysError(`Could not reach Edays at ${this.baseUrl}: ${(err as Error).message}. Check EDAYS_SYSTEM (the subdomain of your Edays system) or EDAYS_BASE_URL.`);
      }
      const retryable = RETRY_ANY_METHOD.has(res.status) || (gatewayRetry && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new EdaysError(`Edays asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${shown} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date
        // already passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const text = res.status === 204 ? "" : await res.text();
      return { status: res.status, headers: res.headers, text, json: text ? safeJson(text) : undefined };
    }
  }

  /** Like request(), but also returns the response headers (the paging code reads them). */
  async requestWithHeaders<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<{ data: T; headers: Headers }> {
    for (let auth = 0; ; auth++) {
      const token = await this.getToken(auth > 0);
      const { status, headers, text, json } = await this.send(method, path, {
        query: opts.query,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      // A cached token may have been revoked or expired early: fetch a fresh one and retry once.
      if (status === 401 && auth === 0) continue;

      if (status === 204) return { data: undefined as T, headers };
      if (status >= 200 && status < 300) {
        // Every documented 2xx body is JSON. A 200 with HTML (a proxy, a captive portal, a login page)
        // must not be mistaken for an empty list or an empty record. The excerpt goes through the
        // contact redaction like every other passed-on text.
        if (text && (json === undefined || typeof json !== "object")) {
          throw new EdaysError(
            `Edays returned ${status} for ${method} ${path} but the body was not JSON (starts with: ${JSON.stringify(redactContacts(text.slice(0, 60), false) ?? "")}). Check EDAYS_SYSTEM / EDAYS_BASE_URL and whether a proxy or login page is in the way.`,
            status,
          );
        }
        return { data: json as T, headers };
      }

      // Edays' error bodies are not documented (only the status codes are); any message is free text,
      // so anything that looks like a contact detail is redacted before it is passed on.
      const detail = redactContacts(describeError(json) ?? (json === undefined ? text.slice(0, 300) : ""), false);
      const suffix = detail ? " " + detail : "";
      if (status === 401) {
        throw new EdaysError(
          `Edays rejected the access token (401) for ${method} ${path}, even after fetching a fresh one. Check that the Api Client user in Edays is still active and that EDAYS_CLIENT_ID / EDAYS_CLIENT_SECRET belong to the system named by EDAYS_SYSTEM.${suffix}`,
          401,
        );
      }
      if (status === 403) throw new EdaysError(`Edays refused ${method} ${path} (403 Forbidden). The Api Client user's roles do not allow this operation; an administrator can change them on the user's Roles tab in Edays.${suffix}`, 403);
      if (status === 404) throw new EdaysError(`Not found: ${path}. Check the ID.${suffix}`, 404);
      if (status === 429) throw new EdaysError("Edays rate limit reached (the limit is not documented). Wait a minute and try again.", 429);
      if (status === 400) throw new EdaysError(`Edays rejected ${method} ${path} (400).${suffix}`, 400);
      if (method !== "GET" && RETRY_GET_ONLY.has(status)) {
        throw new EdaysError(
          `Edays returned ${status} for ${method} ${path}. The request was not retried because it may already have been processed: check with list_absences or get_absence before repeating it.${suffix}`,
          status,
        );
      }
      if (RETRY_GET_ONLY.has(status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a
        // JSON message is passed on.
        const jsonDetail = redactContacts(describeError(json), false);
        throw new EdaysError(`Edays returned ${status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${jsonDetail ? " " + jsonDetail : ""}`, status);
      }
      throw new EdaysError(`Edays returned ${status} for ${method} ${path}.${suffix}`, status);
    }
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, opts)).data;
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Fetch a paged collection (Paging section: "page" and "pagesize" query parameters; the response
   * headers edays-pagination-page, -page-size, -returned and -total describe the page). Only
   * /api/v2/absences and /api/v2/users/{id}/absences are marked as supporting paging.
   *
   * Whole pages only. The page size sent is min(PAGE_SIZE, maxItems), and the loop stops BEFORE a
   * page that could take the total past `maxItems`, so a page is never cut in the middle: cutting a
   * page and pointing the caller at the page after it would silently skip the records beyond the
   * cut. The result therefore holds at most `maxItems` records, possibly fewer than a caller asked
   * for, and `next_page` is the first page not fetched. Because page numbers only line up for one
   * page size, `page_size` is returned too and a continuation call must send the same size.
   *
   * The end of the list is judged from the records actually received, not from the page-size header
   * alone: no maximum page size is documented, and a cap that still echoed the requested size in
   * edays-pagination-page-size would otherwise end the walk after one page with `complete: true`.
   * Stops at an empty page; when the walk began at page 1, once `total` (edays-pagination-total)
   * records have been collected; when it began later, once the pages before it (assumed no larger
   * than the largest page seen) plus the records received reach `total`; with no total header, at a
   * page shorter than requested; or at `maxPages`. A walk that begins after page 1 and lands on a
   * short page cannot tell a last page from a capped one, so it confirms the end with one more
   * request, which returns an empty page.
   */
  async list<T = any>(
    path: string,
    { maxItems = PAGE_SIZE, maxPages = 10, page = 1, query = {} as Record<string, QueryValue> } = {},
  ): Promise<{ items: T[]; total?: number; page_size: number; complete: boolean; next_page?: number }> {
    const pageSize = Math.max(1, Math.min(PAGE_SIZE, maxItems));
    const items: T[] = [];
    let total: number | undefined;
    let current = page;
    let largest = 0; // the most records any page of this walk held
    for (let n = 0; n < maxPages; n++) {
      const { data, headers } = await this.requestWithHeaders<T[]>("GET", path, { query: { ...query, page: current, pagesize: pageSize } });
      const records = Array.isArray(data) ? data : [];
      total = headerInt(headers.get("edays-pagination-total")) ?? total;
      const claimed = headerInt(headers.get("edays-pagination-page-size")) || pageSize;
      items.push(...records);
      largest = Math.max(largest, records.length);
      // What a page really holds: the header's size, unless every page so far was smaller.
      const effective = Math.min(claimed, largest) || claimed;
      const exhausted =
        records.length === 0 ||
        (total !== undefined && (page === 1 ? items.length >= total : (current - 1) * effective + records.length >= total)) ||
        (total === undefined && records.length < pageSize);
      current++;
      if (exhausted) return { items, total, page_size: pageSize, complete: true };
      // The next page may hold up to `effective` records, or fewer when the total says fewer remain.
      // Stop here if that could exceed the budget.
      const remaining = total !== undefined && page === 1 ? Math.max(0, total - items.length) : Infinity;
      if (items.length + Math.min(effective, remaining) > maxItems) break;
    }
    return { items, total, page_size: pageSize, complete: false, next_page: current };
  }
}

/** A non-negative integer header value, or undefined when missing or malformed. */
export function headerInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Error bodies are not documented. The bulk-user example shows {"StatusCode": 400, "Message": "..."};
// an OAuth token endpoint answers {"error": "...", "error_description": "..."}; ASP.NET Web API,
// which the /token response fields (".issued", ".expires") point to, uses {"Message": "...",
// "ModelState": {field: [messages]}}. All four forms are read here.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const parts: string[] = [];
  for (const k of ["Message", "message", "error_description", "error", "ExceptionMessage"]) if (typeof json[k] === "string" && json[k].trim()) parts.push(json[k].trim());
  if (json.ModelState && typeof json.ModelState === "object") {
    const errs = Object.entries(json.ModelState as Record<string, unknown>)
      .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join("; ") : String(msgs)}`)
      .join(" | ");
    if (errs) parts.push(`Validation errors: ${errs}`);
  }
  return parts.length ? [...new Set(parts)].join(" ") : undefined;
}

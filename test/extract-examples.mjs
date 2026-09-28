// Rebuilds spec.json from Edays' public API V2 documentation. Edays publishes no OpenAPI document for
// API V2: the documentation is one HTML page (https://developer.e-days.co.uk, also served as
// developer.e-days.com) with a "Resource URL" and JSON examples ("Example GET Response",
// "Example POST Request", ...) for every endpoint. This script fetches that page, drops the parts the
// page keeps in HTML comments (they are not published), reads every <pre> block in order, and writes
// the examples out keyed by the resource path they follow. The test suite validates the JSON schemas in
// test/schemas.mjs against these examples, so the schemas the fixtures are checked against are the
// documented shapes and not this project's guesses.
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DOC_URL = "https://developer.e-days.co.uk/";

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");

/** "https://YOUR-SYSTEM.e-days.co.uk/api/v2/users/{partnerUserId}/?x=1" -> "/api/v2/users/{partnerUserId}" */
export function normalisePath(url) {
  let p = url.trim().replace(/^https?:\/\/[^/]+/i, "");
  if (!p.startsWith("/")) p = "/" + p;
  p = p.split("?")[0].replace(/\/+$/, "");
  return p;
}

/**
 * The documented resources (path + "Supported HTTP Methods") and examples on one copy of the page, in
 * document order. Every "Resource URL" / "Token URL" <pre> starts a resource; the "Supported HTTP
 * Methods: ..." line that follows it is attached to that resource; every "Example ... Request/Response"
 * <pre> after it is an example on that resource's path. A second "Resource URL" for the same path
 * (applyRotaToUsers is shown with and without its query string; /api/v2/absences once for GET and
 * once for POST) continues the same resource and its methods line is added to it, and a resource
 * whose section has no methods line but an "Example PATCH Request" (the bulk authorisation endpoint)
 * gets that method, marked as inferred.
 */
export function extractExamples(html) {
  const published = html.replace(/<!--[\s\S]*?-->/g, "");
  const resources = [];
  const examples = [];
  let current;
  let last = 0;
  const re = /<pre[^>]*>([\s\S]*?)<\/pre>/g;
  let m;
  while ((m = re.exec(published))) {
    const before = decode(published.slice(last, m.index)).replace(/\s+/g, " ");
    last = m.index + m[0].length;
    const text = decode(m[1]).trim();
    // "Supported HTTP Methods: GET, POST" (optionally "(Supports paging)") belongs to the resource whose
    // URL came just before it, even when that resource has no example of its own.
    const supported = /Supported HTTP Methods:\s*([A-Z]+(?:\s*,\s*[A-Z]+)*)(\s*\(Supports paging\))?/i.exec(before);
    if (supported && current && (current.methods.length === 0 || current.repeated)) {
      for (const method of supported[1].toUpperCase().split(/\s*,\s*/)) if (!current.methods.includes(method)) current.methods.push(method);
      if (supported[2]) current.paging = true;
      current.repeated = false;
    }
    if (/(Resource|Token) URL(?: using \w+)?\s*:?\s*$/i.test(before)) {
      const path = normalisePath(text);
      if (current && current.path === path) {
        current.repeated = true; // a second block of the same resource may carry its own methods line
      } else {
        current = { path, methods: [] };
        resources.push(current);
      }
      continue;
    }
    const label = [...before.matchAll(/Example (?:(GET|POST|PUT|PATCH|DELETE) )?(Request|Response)/g)].pop();
    if (!label || !current) continue;
    const method = label[1] ?? (label[2] === "Response" && current.methods.length === 1 ? current.methods[0] : undefined);
    if (label[1] && current.methods.length === 0) {
      current.methods = [label[1]];
      current.methods_inferred = true;
    }
    // Many examples start with the verb on its own line ("POST\n{ ... }"); drop it before parsing.
    const body = text.replace(/^(GET|POST|PUT|PATCH|DELETE)\s*\n/, "");
    let json;
    let parseError;
    try {
      json = JSON.parse(body);
    } catch (err) {
      parseError = err.message;
    }
    examples.push({ path: current.path, method, kind: label[2].toLowerCase(), ...(parseError ? { text: body, parse_error: parseError } : { json }) });
  }
  // The token endpoint's "Supported HTTP Methods: POST" line sits between two <pre> blocks of its own
  // section; it is picked up above like any other. A resource with neither a methods line nor a
  // method-labelled example stays empty.
  for (const r of resources) delete r.repeated;
  return { resources, examples };
}

export async function assembleSpec(outPath, source = DOC_URL) {
  let html;
  if (/^https?:/.test(source)) {
    const res = await fetch(source, { headers: { Accept: "text/html" } });
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    html = await res.text();
  } else {
    html = readFileSync(source, "utf8");
  }
  if (!/API V2 Documentation/.test(html)) throw new Error(`${source}: this is not the Edays API V2 documentation page`);
  const { resources, examples } = extractExamples(html);
  if (resources.length < 50 || examples.length < 50) throw new Error(`${source}: only ${resources.length} resources and ${examples.length} examples found; the page layout may have changed`);
  const spec = {
    "x-note": `Documented resources and JSON examples extracted on ${new Date().toISOString().slice(0, 10)} from ${source} (Edays API V2 has no OpenAPI document; the schemas in test/schemas.mjs are written from these examples and checked against them). Parts of the page that sit inside HTML comments are not published and are left out.`,
    source,
    resources,
    examples,
  };
  writeFileSync(outPath, JSON.stringify(spec, null, 2));
  return { resources: resources.length, examples: examples.length, unparsable: examples.filter((e) => e.parse_error).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL("../spec.json", import.meta.url));
  const r = await assembleSpec(out, process.argv[2] ?? DOC_URL);
  console.log(`Wrote ${out}: ${r.resources} resources, ${r.examples} examples (${r.unparsable} not valid JSON on the page).`);
}

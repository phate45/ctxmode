// URL fetching for fetch_and_index: an address policy before the first request
// and every redirect, a size cap, a timeout, and HTML→markdown conversion.
import { lookup } from "node:dns/promises";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const MAX_REDIRECTS = 5;
const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface Fetched {
  kind: "json" | "text" | "markdown";
  text: string;
}

/** Two URLs sharing a `source` label get separate cache slots and stored sources. */
export function fetchLabel(source: string | undefined, url: string): string {
  return source === undefined ? url : `${source}::${url}`;
}

/**
 * Classify an IP address.
 *   - "block":    link-local (incl. 169.254.169.254 IMDS), multicast, reserved, malformed
 *   - "private":  loopback, RFC1918, ULA; fetched unless CTXMODE_FETCH_STRICT=1
 *   - "public":   fetched
 */
export function classifyIp(rawIp: string): "block" | "private" | "public" {
  // A zone id (`fe80::1%eth0`) would otherwise defeat the equality checks below.
  const pctIdx = rawIp.indexOf("%");
  const ip = pctIdx === -1 ? rawIp : rawIp.slice(0, pctIdx);
  const lower = ip.toLowerCase();

  if (lower.includes(":")) {
    const v4MappedMatch = lower.match(/^::ffff:([\d.]+)$/);
    if (v4MappedMatch) return classifyIp(v4MappedMatch[1]);
    if (lower === "::") return "block"; // unspecified
    if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
        lower.startsWith("fea") || lower.startsWith("feb")) return "block"; // fe80::/10 link-local
    if (lower.startsWith("ff")) return "block"; // ff00::/8 multicast
    if (lower === "::1") return "private";
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private"; // fc00::/7 ULA
    return "public";
  }

  if (!ip.includes(".")) return "block";
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return "block";
  const [a, b] = parts;
  if (a === 169 && b === 254) return "block"; // link-local incl. IMDS
  if (a === 0) return "block";                 // 0.0.0.0/8
  if (a >= 224) return "block";                // multicast/reserved
  if (a === 127) return "private";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  return "public";
}

/**
 * Why `raw` may not be fetched, or null. http(s) only, and no address the name
 * resolves to may be blocked (or private under CTXMODE_FETCH_STRICT=1). The
 * check runs before connecting: fetch resolves the name again, so a host that
 * rebinds in between is not caught.
 */
export async function checkUrl(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `URL scheme "${url.protocol}" not allowed (only http: and https:)`;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true, verbatim: true });
  } catch (err) {
    return `DNS lookup failed for "${url.hostname}": ${(err as Error).message} (${(err as NodeJS.ErrnoException).code ?? "no code"})`;
  }
  const strict = process.env.CTXMODE_FETCH_STRICT === "1";
  for (const { address } of records) {
    const verdict = classifyIp(address);
    if (verdict === "block") {
      return `URL "${url.hostname}" resolves to ${address} — blocked (link-local / IMDS / multicast / reserved)`;
    }
    if (verdict === "private" && strict) {
      return `URL "${url.hostname}" resolves to private IP ${address} — blocked under CTXMODE_FETCH_STRICT=1`;
    }
  }
  return null;
}

/** Fetch a URL that already passed checkUrl, re-checking each redirect target before following it. */
export async function fetchUrl(raw: string): Promise<Fetched> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = raw;
  for (let hop = 0; ; hop++) {
    const resp = await fetch(url, { redirect: "manual", signal });
    const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
    if (!location) return readBody(resp);
    if (hop === MAX_REDIRECTS) throw new Error(`redirect chain exceeded ${MAX_REDIRECTS} hops`);
    url = new URL(location, url).toString();
    const blocked = await checkUrl(url);
    if (blocked) throw new Error(`redirect to ${url}: ${blocked}`);
  }
}

async function readBody(resp: Response): Promise<Fetched> {
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (Number(resp.headers.get("content-length")) > MAX_BYTES) {
    throw new Error(`response too large: Content-Length ${resp.headers.get("content-length")} exceeds ${MAX_BYTES}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of resp.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`response too large: over ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  const type = resp.headers.get("content-type") ?? "";
  if (type.includes("application/json") || type.includes("+json")) {
    try {
      return { kind: "json", text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      return { kind: "text", text };
    }
  }
  if (type.includes("text/html") || type.includes("application/xhtml")) return { kind: "markdown", text: htmlToMarkdown(text) };
  return { kind: "text", text };
}

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.use(gfm);
  td.remove(["script", "style", "nav", "header", "footer", "noscript"]);
  return td.turndown(html);
}

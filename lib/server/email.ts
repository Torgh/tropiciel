/**
 * One e-mail the user saved as a file (.eml: Gmail "Pobierz wiadomość", Outlook / Thunderbird "Zapisz jako") –
 * a job alert or a reply from an employer. Tropiciel never connects to the mailbox: it reads only the files the user
 * hands over. Plain MIME, no dependencies.
 */
import { decodeEntities, htmlToText } from "./http";
import { BLOCKED_HOSTS, linkedInJobId } from "./sources";

export interface EmailLink {
  url: string;
  /** The link's text in the HTML part (often the offer's title). */
  label?: string;
}

export interface ParsedEmail {
  from?: string;
  to?: string;
  subject?: string;
  /** ISO, from the Date header. */
  date?: string;
  text: string;
  links: EmailLink[];
  /** LinkedIn offers in the message, as canonical job links. */
  linkedInJobs: string[];
}

interface Part {
  headers: Record<string, string>;
  body: string;
}

function splitHead(raw: string): Part {
  const m = raw.match(/\r?\n\r?\n/);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index! + m[0].length) : "";
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
  }
  return { headers, body };
}

const param = (header: string | undefined, name: string) =>
  header?.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"))?.slice(1).find(Boolean);

function decodeBytes(bytes: Uint8Array, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const latin1Bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function qpBytes(s: string, header = false): Uint8Array {
  const src = (header ? s.replace(/_/g, " ") : s).replace(/=\r?\n/g, "");
  return latin1Bytes(src.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
}

const b64Bytes = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ""), "base64"));

/** "=?UTF-8?B?...?=" / "=?iso-8859-2?Q?...?=" in headers. */
export function decodeHeader(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  return v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) =>
      decodeBytes(enc.toUpperCase() === "B" ? b64Bytes(data) : qpBytes(data, true), cs),
    )
    .trim();
}

function partText(p: Part): string {
  const enc = (p.headers["content-transfer-encoding"] ?? "").toLowerCase();
  const charset = param(p.headers["content-type"], "charset") ?? "utf-8";
  // The file was read as latin1, so every byte is one char: decode transfer encoding, then the charset.
  const bytes = enc === "base64" ? b64Bytes(p.body) : enc === "quoted-printable" ? qpBytes(p.body) : latin1Bytes(p.body);
  return decodeBytes(bytes, charset);
}

/** The text/plain and text/html parts, depth first; attachments are skipped. */
function leaves(p: Part, out: { plain: string[]; html: string[] }) {
  const type = (p.headers["content-type"] ?? "text/plain").toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = param(p.headers["content-type"], "boundary");
    if (!boundary) return;
    const chunks = p.body.split(`--${boundary}`).slice(1);
    for (const chunk of chunks) {
      if (chunk.startsWith("--")) break;
      leaves(splitHead(chunk.replace(/^\r?\n/, "")), out);
    }
    return;
  }
  if (/attachment/i.test(p.headers["content-disposition"] ?? "")) return;
  if (type.startsWith("text/html")) out.html.push(partText(p));
  else if (type.startsWith("text/plain")) out.plain.push(partText(p));
}

const TRAILING = /[).,;>\]]+$/;
const NOISE = /unsubscribe|wypisz|preferences|ustawienia-powiadomien|privacy|polityka|help|pomoc|\/legal\/|\/settings|\.(png|jpe?g|gif)(\?|$)/i;

/** Tracking parameters off, LinkedIn offers to their canonical link. */
function cleanLink(raw: string): string | undefined {
  try {
    const u = new URL(decodeEntities(raw).replace(TRAILING, ""));
    if (!/^https?:$/.test(u.protocol)) return undefined;
    const li = linkedInJobId(u.href);
    if (li) return `https://www.linkedin.com/jobs/view/${li}`;
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|trk|tracking|refId|lipi|midToken|midSig|eid|otpToken)/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.href;
  } catch {
    return undefined;
  }
}

/** Reads a saved .eml file (its bytes as a latin1 string or a Buffer). */
export function parseEmail(input: string | Uint8Array): ParsedEmail {
  const raw = typeof input === "string" ? input : Buffer.from(input).toString("latin1");
  const top = splitHead(raw);
  if (!top.headers["from"] && !top.headers["subject"] && !top.headers["content-type"]) {
    throw new Error("to nie wygląda na plik .eml – zapisz wiadomość jako .eml (Gmail: ⋮ → Pobierz wiadomość) albo wyślij zrzut ekranu");
  }
  const parts = { plain: [] as string[], html: [] as string[] };
  leaves(top, parts);
  const html = parts.html.join("\n");

  const links = new Map<string, EmailLink>();
  const add = (href: string, label?: string) => {
    if (NOISE.test(href) || (label && NOISE.test(label))) return;
    const url = cleanLink(href);
    if (!url) return;
    const prev = links.get(url);
    const text = label && htmlToText(label).replace(/\s+/g, " ").trim();
    if (!prev) links.set(url, { url, label: text || undefined });
    else if (!prev.label && text) prev.label = text;
  };
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) add(m[1], m[2]);
  for (const m of parts.plain.join("\n").matchAll(/https?:\/\/[^\s<>"']+/g)) add(m[0]);

  const text = (parts.plain.join("\n\n").trim() || htmlToText(html)).replace(/\n{3,}/g, "\n\n");
  const date = top.headers["date"] && !Number.isNaN(Date.parse(top.headers["date"])) ? new Date(top.headers["date"]).toISOString() : undefined;
  const all = [...links.values()];
  return {
    from: decodeHeader(top.headers["from"]),
    to: decodeHeader(top.headers["to"]),
    subject: decodeHeader(top.headers["subject"]),
    date,
    text,
    links: all,
    linkedInJobs: all.map((l) => l.url).filter((u) => /linkedin\.com\/jobs\/view\/\d+$/.test(u)),
  };
}

/** True for links Tropiciel may not fetch (Pracuj.pl, theprotocol.it, OLX): read their offers from the e-mail text. */
export const blockedLink = (url: string) => {
  try {
    return BLOCKED_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

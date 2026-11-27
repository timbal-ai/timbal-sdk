/**
 * Minimal MIME parsing for inbound email attachments (`.eml`).
 *
 * The framework can't read an email on every model route (its `.eml`
 * handling raises on the OpenAI Responses route), and as plain text a raw
 * MIME message carries its attachments base64-encoded into the prompt. So
 * the pipeline turns an email into its readable text (main headers and
 * body) plus its attachments, each of which then goes through the same
 * checks as any other file.
 *
 * Covers what mail clients produce: nested multipart, `multipart/alternative`
 * (plain text preferred over HTML), base64 and quoted-printable bodies,
 * charsets, RFC 2047 encoded words and RFC 2231 parameters. Anything it
 * can't make sense of is kept as body text rather than dropped.
 */

/** A file attached to an email. */
export interface EmailAttachment {
  fileName: string;
  contentType: string;
  data: Uint8Array;
}

/** An email's readable text and its attachments. */
export interface ParsedEmail {
  /** Main headers, a list of attachment names, then the body. */
  text: string;
  attachments: EmailAttachment[];
}

/** Multipart nesting followed before the rest is ignored. */
const MAX_DEPTH = 8;
/** Parts read before the rest is ignored (a guard against crafted input). */
const MAX_PARTS = 200;

const SUMMARY_HEADERS = ['from', 'to', 'cc', 'date', 'subject'] as const;

interface Part {
  headers: Map<string, string>;
  /** The raw body, one char per byte. */
  body: string;
}

interface HeaderValue {
  value: string;
  params: Map<string, string>;
}

/** Bytes ↔ a string of one char per byte, so boundaries can be searched. */
function toBinary(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');
}

function fromBinary(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

function decodeText(bytes: Uint8Array, charset: string | undefined): string {
  try {
    const label = (charset?.trim() || 'utf-8') as ConstructorParameters<typeof TextDecoder>[0];
    return new TextDecoder(label).decode(bytes);
  } catch {
    // A label the runtime doesn't know (Bun lacks e.g. iso-8859-15):
    // UTF-8 when the bytes are valid UTF-8, else Windows-1252.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}

/** Header bytes: UTF-8 when valid (RFC 6532), else read as Latin-1. */
function headerText(value: string): string {
  if (!/[\x80-\xff]/.test(value)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(fromBinary(value));
  } catch {
    return value;
  }
}

function splitPart(raw: string): Part {
  const blank = /\r?\n\r?\n/.exec(raw);
  const head = blank ? raw.slice(0, blank.index) : raw;
  const body = blank ? raw.slice(blank.index + blank[0].length) : '';
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, headerText(line.slice(colon + 1).trim()));
  }
  return { headers, body };
}

/** Splits on `sep` outside double quotes. */
function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '\\' && quoted && i + 1 < s.length) {
      current += c + s[++i];
    } else if (c === '"') {
      quoted = !quoted;
      current += c;
    } else if (c === sep && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"')
    ? t.slice(1, -1).replace(/\\(.)/g, '$1')
    : t;
}

/** Decodes `<escape>XX` hex escapes to bytes (`%` in RFC 2231, `=` in RFC 2047 Q). */
function hexEscapedBytes(s: string, escape: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === escape && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return out;
}

/**
 * `attachment; filename*0*=UTF-8''%E2%82%AC; filename*1=".pdf"` →
 * `{ value: 'attachment', params: { filename: '€.pdf' } }`.
 */
function parseHeaderValue(header: string): HeaderValue {
  const [first = '', ...rest] = splitUnquoted(header, ';');
  const segments = new Map<string, { index: number; extended: boolean; text: string }[]>();
  for (const item of rest) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const key = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(item.slice(0, eq).trim());
    if (!key) continue;
    const name = (key[1] ?? '').toLowerCase();
    const list = segments.get(name) ?? [];
    list.push({
      index: key[2] ? Number(key[2]) : 0,
      extended: Boolean(key[3]),
      text: unquote(item.slice(eq + 1)),
    });
    segments.set(name, list);
  }
  const params = new Map<string, string>();
  for (const [name, list] of segments) {
    list.sort((a, b) => a.index - b.index);
    if (!list.some((s) => s.extended)) {
      params.set(name, list.map((s) => s.text).join(''));
      continue;
    }
    // RFC 2231: the first extended segment starts with `charset'language'`.
    let charset = 'utf-8';
    const bytes: number[] = [];
    list.forEach((s, i) => {
      let text = s.text;
      if (i === 0 && s.extended) {
        const parts = text.split("'");
        if (parts.length >= 3) {
          charset = parts[0] || charset;
          text = parts.slice(2).join("'");
        }
      }
      bytes.push(...(s.extended ? hexEscapedBytes(text, '%') : new TextEncoder().encode(text)));
    });
    params.set(name, decodeText(Uint8Array.from(bytes), charset));
  }
  return { value: first.trim().toLowerCase(), params };
}

/** RFC 2047: `=?UTF-8?B?w6l0w6k=?=` → `été`. */
function decodeWords(s: string): string {
  return s.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(?:\s+(?==\?))?/g,
    (_match, charset: string, encoding: string, text: string) => {
      const bytes =
        encoding.toUpperCase() === 'B'
          ? new Uint8Array(Buffer.from(text, 'base64'))
          : Uint8Array.from(hexEscapedBytes(text.replace(/_/g, ' '), '='));
      return decodeText(bytes, charset.split('*')[0]);
    },
  );
}

function decodeQuotedPrintable(s: string): Uint8Array {
  const text = s.replace(/=\r?\n/g, '');
  const out = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[n++] = parseInt(hex, 16);
      i += 2;
    } else {
      out[n++] = text.charCodeAt(i) & 0xff;
    }
  }
  return out.slice(0, n);
}

function decodeBody(part: Part): Uint8Array {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
  if (encoding === 'base64') {
    return new Uint8Array(Buffer.from(part.body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
  }
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(part.body);
  return fromBinary(part.body);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The parts between `--boundary` lines; preamble and epilogue dropped. */
function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = new RegExp(
    `(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?:\\r?\\n|$)`,
    'g',
  );
  const parts: string[] = [];
  let start = -1;
  for (let m = delimiter.exec(body); m; m = delimiter.exec(body)) {
    if (start >= 0) parts.push(body.slice(start, m.index));
    if (m[1]) return parts;
    start = delimiter.lastIndex;
  }
  if (start >= 0) parts.push(body.slice(start));
  return parts;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function contentTypeOf(part: Part): HeaderValue {
  const header = part.headers.get('content-type');
  const parsed = parseHeaderValue(header ?? 'text/plain');
  return parsed.value ? parsed : { value: 'text/plain', params: parsed.params };
}

interface Collected {
  texts: string[];
  htmls: string[];
  attachments: EmailAttachment[];
  parts: number;
}

function collect(part: Part, depth: number, out: Collected): void {
  if (++out.parts > MAX_PARTS) return;
  const type = contentTypeOf(part);
  const disposition = parseHeaderValue(part.headers.get('content-disposition') ?? '');
  const name = decodeWords(disposition.params.get('filename') ?? type.params.get('name') ?? '').trim();

  const boundary = type.params.get('boundary');
  if (type.value.startsWith('multipart/') && boundary && depth < MAX_DEPTH) {
    const children = splitMultipart(part.body, boundary).map(splitPart);
    if (type.value === 'multipart/alternative') {
      // Clients put the richest version last; plain text reads best.
      const pick =
        children.findLast((c) => contentTypeOf(c).value === 'text/plain') ??
        children.findLast((c) => contentTypeOf(c).value === 'text/html') ??
        children.at(-1);
      if (pick) collect(pick, depth + 1, out);
    } else {
      for (const child of children) collect(child, depth + 1, out);
    }
    return;
  }

  const isBodyText =
    disposition.value !== 'attachment' &&
    !name &&
    (type.value === 'text/plain' || type.value === 'text/html');
  if (isBodyText) {
    const text = decodeText(decodeBody(part), type.params.get('charset'));
    if (type.value === 'text/html') out.htmls.push(htmlToText(text));
    else out.texts.push(text.trim());
    return;
  }

  const fallback = type.value === 'message/rfc822' ? 'forwarded' : 'attachment';
  out.attachments.push({
    fileName: name || `${fallback}-${out.attachments.length + 1}${type.value === 'message/rfc822' ? '.eml' : ''}`,
    contentType: type.value,
    data: decodeBody(part),
  });
}

/**
 * The readable text and attachments of a raw email. Input without email
 * headers comes back as text, unchanged.
 */
export function parseEmail(data: Uint8Array): ParsedEmail {
  const root = splitPart(toBinary(data));
  const isEmail =
    root.headers.has('content-type') ||
    root.headers.has('mime-version') ||
    SUMMARY_HEADERS.some((h) => root.headers.has(h));
  if (!isEmail) return { text: decodeText(data, 'utf-8'), attachments: [] };

  const out: Collected = { texts: [], htmls: [], attachments: [], parts: 0 };
  collect(root, 0, out);

  const lines: string[] = [];
  for (const header of SUMMARY_HEADERS) {
    const value = root.headers.get(header);
    if (value) lines.push(`${header.charAt(0).toUpperCase()}${header.slice(1)}: ${decodeWords(value)}`);
  }
  if (out.attachments.length > 0) {
    lines.push(`Attachments: ${out.attachments.map((a) => a.fileName).join(', ')}`);
  }
  const body = (out.texts.length > 0 ? out.texts : out.htmls).filter(Boolean).join('\n\n');
  return { text: `${lines.join('\n')}\n\n${body}`.trim(), attachments: out.attachments };
}

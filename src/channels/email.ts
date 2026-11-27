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
 * Covers what mail clients produce: nested multipart, `multipart/mixed`
 * sections in order, `multipart/alternative` (the plain-text version when
 * it has text, else the richest one with text), base64 and
 * quoted-printable bodies, charsets, RFC 2047 encoded words and RFC 2231
 * parameters. HTML becomes text with link destinations kept. Anything it
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
  // A part that starts with a blank line has no headers.
  const headerless = /^\r?\n/.exec(raw);
  if (headerless) return { headers: new Map(), body: raw.slice(headerless[0].length) };
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

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * Elements dropped with their content. `head` isn't one: its end tag may be
 * omitted (`<head><title>…</title><body>…`), so only what it holds that
 * shows no text — the title, scripts, styles — is dropped.
 */
const SKIPPED_TAGS = new Set(['script', 'style', 'title']);
/** Tags whose end starts a new line. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote',
]);

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

function isLetter(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
}

/**
 * The index of the `>` ending the tag whose name starts at `from`, past
 * quoted attribute values (`title="a > b"`), or -1 when a quote never
 * closes.
 */
function tagEnd(html: string, from: number): number {
  let quote = '';
  let valueNext = false;
  for (let j = from; j < html.length; j++) {
    const c = html.charAt(j);
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '>') {
      return j;
    } else if (c === '=') {
      valueNext = true;
    } else if (valueNext && (c === '"' || c === "'")) {
      quote = c;
      valueNext = false;
    } else if (!isSpace(c)) {
      valueNext = false;
    }
  }
  return -1;
}

/** A tag's attributes (`a data-href="x" href=y` → data-href, href), names lowercased. */
function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let j = 0;
  while (j < tag.length && !isSpace(tag[j]) && tag[j] !== '/') j++; // the tag name
  while (j < tag.length) {
    while (j < tag.length && (isSpace(tag[j]) || tag[j] === '/')) j++;
    const nameStart = j;
    while (j < tag.length && !isSpace(tag[j]) && tag[j] !== '=' && tag[j] !== '/') j++;
    const name = tag.slice(nameStart, j).toLowerCase();
    while (j < tag.length && isSpace(tag[j])) j++;
    let value = '';
    if (tag[j] === '=') {
      j++;
      while (j < tag.length && isSpace(tag[j])) j++;
      const quote = tag[j];
      if (quote === '"' || quote === "'") {
        const close = tag.indexOf(quote, j + 1);
        const valueEnd = close < 0 ? tag.length : close;
        value = tag.slice(j + 1, valueEnd);
        j = valueEnd + 1;
      } else {
        const valueStart = j;
        while (j < tag.length && !isSpace(tag[j])) j++;
        value = tag.slice(valueStart, j);
      }
    }
    // The first of a repeated attribute wins, as in browsers.
    if (name && !attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

/**
 * What follows a link's label so the agent can give the destination:
 * ` (https://x)` for `<a href="https://x">Join</a>`. Only web, mail and
 * phone links, and nothing when the label already shows the destination.
 */
function linkSuffix(label: string, href: string): string {
  if (!/^(https?:|mailto:|tel:)/i.test(href)) return '';
  if (!label) return ` ${href}`;
  const shown = href.replace(/^(mailto|tel):/i, '');
  return label === href || label === shown ? '' : ` (${href})`;
}

/** The index of `</name` (any case) from `from`, or -1. */
function endTagIndex(html: string, name: string, from: number): number {
  for (let j = html.indexOf('</', from); j >= 0; j = html.indexOf('</', j + 2)) {
    if (html.slice(j + 2, j + 2 + name.length).toLowerCase() === name) return j;
  }
  return -1;
}

/**
 * HTML → text: tags and comments dropped (scripts, styles and the title
 * with their content), line breaks for `<br>` and block ends, links as
 * `label (destination)`. One forward scan, so crafted input — unclosed
 * tags, a run of `<` — costs linear time instead of blocking the server.
 */
function htmlToText(html: string): string {
  // Chunks, joined once at the end: a link only touches its own chunks.
  const out: string[] = [];
  let link: { href: string; start: number } | undefined;
  const closeLink = (): void => {
    if (!link) return;
    const label = out.slice(link.start).join('');
    const suffix = linkSuffix(label.trim(), link.href);
    if (suffix) {
      // `Join (https://x) ` rather than `Join  (https://x)`.
      const text = label.trimEnd();
      out.splice(link.start, out.length - link.start, text, suffix, label.slice(text.length));
    }
    link = undefined;
  };

  // An end tag not found from one point isn't found from any later one.
  const missingEndTags = new Set<string>();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(decodeEntities(html.slice(i)));
      break;
    }
    out.push(decodeEntities(html.slice(i, lt)));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break; // unclosed: the rest is the comment
      i = end + 3;
      continue;
    }
    const next = html.charAt(lt + 1);
    if (next === '!' || next === '?') {
      // Doctype, CDATA, processing instruction.
      const end = html.indexOf('>', lt + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    const closing = next === '/';
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isLetter(html[nameStart])) {
      // `1 < 2`: a `<` that starts no tag is text.
      out.push('<');
      i = lt + 1;
      continue;
    }
    let gt = tagEnd(html, nameStart);
    if (gt < 0) gt = html.indexOf('>', nameStart); // a quote that never closes
    if (gt < 0) {
      out.push(decodeEntities(html.slice(lt)));
      break;
    }
    i = gt + 1;
    const tag = html.slice(nameStart, gt);
    let nameEnd = 0;
    while (nameEnd < tag.length && !isSpace(tag[nameEnd]) && tag[nameEnd] !== '/') nameEnd++;
    const name = tag.slice(0, nameEnd).toLowerCase();

    if (!closing && SKIPPED_TAGS.has(name)) {
      const end = missingEndTags.has(name) ? -1 : endTagIndex(html, name, i);
      if (end < 0) {
        missingEndTags.add(name);
        if (name === 'title') continue; // a title left open: keep what follows
        break; // an unclosed script or style: the rest is its content
      }
      const endGt = html.indexOf('>', end);
      i = endGt < 0 ? html.length : endGt + 1;
    } else if (name === 'a') {
      closeLink(); // links don't nest; an unclosed one ends here
      const href = closing ? '' : decodeEntities((attributesOf(tag).get('href') ?? '').trim());
      if (href) link = { href, start: out.length };
    } else if (name === 'br') {
      out.push('\n');
    } else if (closing && BLOCK_TAGS.has(name)) {
      out.push('\n');
    }
  }
  closeLink();

  return out
    .join('')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A part's type. Without a `Content-Type` it is `text/plain`, except in a
 * `multipart/digest`, where each entry is an email (RFC 2046 §5.1.5).
 */
function contentTypeOf(part: Part, defaultType = 'text/plain'): HeaderValue {
  const header = part.headers.get('content-type');
  const parsed = parseHeaderValue(header ?? defaultType);
  return parsed.value ? parsed : { value: defaultType, params: parsed.params };
}

interface Collected {
  /** Body sections in source order, HTML already turned into text. */
  bodies: string[];
  /** Unnamed attachments get a name once all are collected. */
  attachments: EmailAttachment[];
}

/** Parts read so far, shared by every branch of one email. */
interface Budget {
  parts: number;
}

function collect(
  part: Part,
  depth: number,
  out: Collected,
  budget: Budget,
  defaultType = 'text/plain',
): void {
  if (++budget.parts > MAX_PARTS) return;
  const type = contentTypeOf(part, defaultType);
  const disposition = parseHeaderValue(part.headers.get('content-disposition') ?? '');
  const name = decodeWords(disposition.params.get('filename') ?? type.params.get('name') ?? '').trim();

  const boundary = type.params.get('boundary');
  if (type.value.startsWith('multipart/') && boundary && depth < MAX_DEPTH) {
    const children = splitMultipart(part.body, boundary).map(splitPart);
    if (type.value === 'multipart/alternative') {
      collectAlternative(children, depth + 1, out, budget);
    } else {
      // `mixed`, `related`, `digest`, ...: every section, in order.
      const childType = type.value === 'multipart/digest' ? 'message/rfc822' : 'text/plain';
      for (const child of children) collect(child, depth + 1, out, budget, childType);
    }
    return;
  }

  const isBodyText =
    disposition.value !== 'attachment' &&
    !name &&
    (type.value === 'text/plain' || type.value === 'text/html');
  if (isBodyText) {
    const text = decodeText(decodeBody(part), type.params.get('charset')).replace(/\r\n?/g, '\n');
    out.bodies.push(type.value === 'text/html' ? htmlToText(text) : text.trim());
    return;
  }

  out.attachments.push({ fileName: name, contentType: type.value, data: decodeBody(part) });
}

/**
 * The versions of one message: the body comes from the plain-text version
 * when it has text, else from the last (richest) version with text. Files
 * are kept from every version — an inline image lives only in the HTML one.
 */
function collectAlternative(children: Part[], depth: number, out: Collected, budget: Budget): void {
  const versions = children.map((child) => {
    const version: Collected = { bodies: [], attachments: [] };
    collect(child, depth, version, budget);
    return { plain: contentTypeOf(child).value === 'text/plain', version };
  });
  const withText = versions.filter((v) => v.version.bodies.some(Boolean));
  const pick = withText.find((v) => v.plain) ?? withText.at(-1);
  if (pick) out.bodies.push(...pick.version.bodies);

  // The same file repeated across versions is kept once; files that only
  // share a name, type and size (two `chart.gif`) are both kept.
  const seen = new Map<string, Uint8Array[]>();
  for (const { version } of versions) {
    for (const file of version.attachments) {
      const key = `${file.fileName}\0${file.contentType}\0${file.data.byteLength}`;
      const same = seen.get(key) ?? [];
      if (same.some((data) => Buffer.from(data).equals(file.data))) continue;
      seen.set(key, [...same, file.data]);
      out.attachments.push(file);
    }
  }
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

  const out: Collected = { bodies: [], attachments: [] };
  collect(root, 0, out, { parts: 0 });
  const attachments = out.attachments.map((file, i) => {
    if (file.fileName) return file;
    const forwarded = file.contentType === 'message/rfc822';
    return { ...file, fileName: forwarded ? `forwarded-${i + 1}.eml` : `attachment-${i + 1}` };
  });

  const lines: string[] = [];
  for (const header of SUMMARY_HEADERS) {
    const value = root.headers.get(header);
    if (value) lines.push(`${header.charAt(0).toUpperCase()}${header.slice(1)}: ${decodeWords(value)}`);
  }
  if (attachments.length > 0) {
    lines.push(`Attachments: ${attachments.map((a) => a.fileName).join(', ')}`);
  }
  const body = out.bodies.filter(Boolean).join('\n\n');
  return { text: `${lines.join('\n')}\n\n${body}`.trim(), attachments };
}

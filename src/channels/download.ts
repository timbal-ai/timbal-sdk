/**
 * Helpers adapters share when downloading an inbound attachment from their
 * provider: capped reads, a deadline, and checks that what came back is the
 * file and not an error page.
 */
import type { ChannelAttachment } from './types';

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export function baseMimeType(mime: string | null | undefined): string | undefined {
  const base = mime?.split(';')[0]?.trim().toLowerCase();
  return base || undefined;
}

/** The attachment kind for a MIME type; anything not image, audio or video is a document. */
export function attachmentKind(mime: string | undefined): ChannelAttachment['kind'] {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * Whether `mime` is an HTML type. For providers that declare a file's type
 * reliably, an HTML body is expected only for these; for anything else it
 * is an error or sign-in page.
 */
export function isHtmlType(mime: string | undefined): boolean {
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

/** Whether `data` starts like an HTML document (an error or login page, not a file). */
export function looksLikeHtml(data: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(data.subarray(0, 512))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/**
 * Declared types a user-sent *document* can have while really being HTML
 * (or unknown): an HTML body is accepted for these. Images, audio, PDFs and
 * other binary types never legitimately arrive as HTML.
 */
export function htmlPlausible(mime: string | undefined): boolean {
  return (
    !mime ||
    mime.startsWith('text/') ||
    mime === 'application/xhtml+xml' ||
    mime === 'application/xml' ||
    mime === 'application/octet-stream'
  );
}

/**
 * Whether a downloaded body is an error or sign-in page rather than the
 * file: served as HTML, or starting like HTML when the declared type is
 * binary. A declared HTML file is the file, and so is text that merely
 * starts with a doctype (a `.txt` or snippet holding HTML source).
 */
export function isErrorPage(
  declared: string | undefined,
  served: string | undefined,
  data: Uint8Array,
): boolean {
  if (isHtmlType(declared)) return false;
  if (served === 'text/html') return true;
  return !htmlPlausible(declared) && looksLikeHtml(data);
}

/**
 * The image type of `data` from its first bytes, for providers that declare
 * only `image/*`. Covers the formats agents read (JPEG, PNG, GIF, WebP).
 */
export function sniffImageType(data: Uint8Array): string | undefined {
  const at = (i: number) => data[i];
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * Reads `res` into memory, refusing bodies over `maxBytes` (by the declared
 * `Content-Length` before reading, and by the bytes actually read).
 */
export async function readCapped(
  res: Response,
  maxBytes: number,
  tooLarge: () => Error
): Promise<Uint8Array> {
  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

/**
 * GET `url`, following up to `maxRedirects` redirects by hand so each hop
 * sends only the headers `headersFor` grants its URL: a credential meant for
 * one host never rides a redirect to another. Every URL must be `https:`
 * and pass `allowHop`, so a redirect can't point the server at a plain-HTTP
 * or internal address.
 */
export async function fetchFollowingRedirects(
  url: URL,
  opts: {
    signal: AbortSignal;
    headersFor: (url: URL) => Record<string, string>;
    /** Names the download in errors. */
    label: string;
    maxRedirects?: number;
    /** Hosts a redirect may lead to. @default any https URL */
    allowHop?: (url: URL) => boolean;
  }
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const allowed = (hop: URL) => hop.protocol === 'https:' && (opts.allowHop?.(hop) ?? true);
  let current = url;
  for (let hops = 0; ; hops++) {
    if (!allowed(current)) {
      throw new Error(`${opts.label} led to a URL that isn't allowed (${current.protocol}//${current.host})`);
    }
    const res = await fetch(current.href, {
      headers: opts.headersFor(current),
      redirect: 'manual',
      signal: opts.signal,
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => {});
    if (hops >= maxRedirects) throw new Error(`${opts.label} redirected too many times`);
    current = new URL(location, current);
  }
}

/**
 * Runs `run` with an abort signal that fires after `ms`, and fails with
 * `timedOut()` then — even when `run` is stuck on a step that ignores the
 * signal (a shared token request).
 */
export async function withDeadline<T>(
  ms: number,
  timedOut: () => Error,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  let onAbort = (): void => {};
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(timedOut());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([run(signal), deadline]);
  } catch (err) {
    if (signal.aborted) throw timedOut();
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

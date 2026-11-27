/**
 * Which inbound attachments Timbal agents can read.
 *
 * The agent framework works out a file's type from its URL's extension (the
 * temp-file URL keeps the uploaded file name) and the type it is served
 * with, and turns images, PDFs, Word and Excel files into model input.
 * Anything else is decoded as text — fine for text files, but a binary file
 * (pptx, zip, HEIC, ...) becomes junk text in the prompt.
 */

/**
 * Extension → MIME type of the binary formats agents can read. Images stop
 * at what the model APIs accept: the framework passes images through
 * unconverted, and Anthropic and OpenAI take only JPEG, PNG, GIF and WebP —
 * a BMP or TIFF would fail the run.
 */
const AGENT_BINARY_TYPES = new Map<string, string>([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

/** MIME type → the extension to give a file of that type (the first listed). */
const AGENT_BINARY_EXTENSIONS = new Map<string, string>();
for (const [ext, mime] of AGENT_BINARY_TYPES) {
  if (!AGENT_BINARY_EXTENSIONS.has(mime)) AGENT_BINARY_EXTENSIONS.set(mime, ext);
}

/**
 * Extensions of text files. The framework decodes these as text whatever
 * type the channel declared — clients often send `application/octet-stream`
 * for a `.csv` or a `.py`.
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'md', 'markdown', 'rst',
  'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'html', 'htm', 'xhtml',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'sql', 'graphql', 'ics', 'vcf', 'srt', 'vtt', 'tex', 'svg',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'go', 'rs', 'rb',
  'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'scala', 'r', 'lua',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'css', 'scss', 'vue', 'svelte',
]);

/**
 * Compressed files. The framework would decode the compressed bytes as text
 * (`data.csv.gz` declared `text/csv`), so they are refused whatever type
 * they declare.
 */
const COMPRESSED_EXTENSIONS = new Set([
  'gz', 'gzip', 'tgz', 'svgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'lz', 'lzma',
  'zst', 'z', 'br', 'zip', '7z', 'rar', 'tar',
]);

/** Content types the framework reads fine as text, whatever the extension. */
function isTextual(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript' ||
    mime === 'application/ecmascript' ||
    mime === 'application/yaml' ||
    mime === 'application/x-yaml' ||
    mime === 'application/toml' ||
    mime === 'application/sql' ||
    mime === 'application/x-sh' ||
    mime === 'application/x-ndjson' ||
    mime === 'message/rfc822' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  );
}

/**
 * Non-standard spellings clients send for supported types. The model APIs
 * reject an image whose media type is `image/jpg`, and the framework only
 * reads a PDF typed exactly `application/pdf`.
 */
const MIME_ALIASES = new Map<string, string>([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
  ['application/x-pdf', 'application/pdf'],
]);

/** `IMAGE/JPG; q=1` → `image/jpeg`. */
function normalizeMime(contentType: string): string {
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return MIME_ALIASES.get(mime) ?? mime;
}

/**
 * Splits `Report.DOCX` into `Report` and `docx`, and `.env` into `` and
 * `env`; no extension → `undefined`.
 */
function splitExtension(fileName: string): { base: string; ext: string } | undefined {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return undefined;
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot + 1).toLowerCase() };
}

/**
 * Text is uploaded with a text type. An `image/*` one (SVG) would send it
 * down the framework's image path, which rejects it.
 */
function textContentType(mime: string, contentType: string): string {
  return isTextual(mime) && !mime.startsWith('image/') ? contentType : 'text/plain';
}

/**
 * Emails are uploaded as plain text. The framework's `.eml` handling isn't
 * implemented on the OpenAI Responses route (its default for OpenAI models)
 * and fails the run there; as text, every model reads the message.
 */
function emailAsText(base: string): AgentReadableUpload {
  return { fileName: `${base}.eml.txt`, contentType: 'text/plain', kind: 'email' };
}

/** Whether a content type is audio, which the pipeline transcribes. */
export function isAudioContentType(contentType: string | undefined): boolean {
  return normalizeMime(contentType ?? '').startsWith('audio/');
}

/** The name and content type to upload an attachment under. */
export interface AgentReadableUpload {
  fileName: string;
  contentType: string;
  /**
   * `binary`: an image, PDF, Word or Excel file. `text`: read as text, so
   * its bytes should look like text. `email`: parse it (see `parseEmail`)
   * and upload its text.
   */
  kind: 'binary' | 'text' | 'email';
}

/**
 * The name and content type to upload an attachment under so an agent can
 * read it, or `null` when agents can't (the attachment should be skipped).
 *
 * The framework picks Word, Excel and email handling by a case-sensitive
 * extension match, and the type the file is served with decides images and
 * PDFs, so the two must agree:
 *
 * - A supported binary file gets its standard type: the declared one when
 *   that is supported, else its extension's (`photo.jpg` + `image/jpg` or
 *   `application/octet-stream` → `image/jpeg`). Its name gets that type's
 *   extension, lowercased (`Report.DOCX` → `Report.docx`): a mismatched
 *   supported one is replaced (`report.pdf` + Word → `report.docx`), any
 *   other kept and appended to (`document_42` + PDF → `document_42.pdf`).
 * - An email is uploaded as text (`Mail.eml` → `Mail.eml.txt`).
 * - A compressed file is refused (`data.csv.gz`, `drawing.svgz`).
 * - Other text is recognized by its extension or its type, and uploaded with
 *   a text type. A text extension declared as video or audio is refused:
 *   `segment.ts` + `video/mp2t` is a video, not TypeScript.
 */
export function agentReadableUpload(
  fileName: string,
  contentType: string,
): AgentReadableUpload | null {
  const mime = normalizeMime(contentType);
  const parts = splitExtension(fileName);
  const ext = parts?.ext;
  if (ext && COMPRESSED_EXTENSIONS.has(ext)) return null;
  const extType = ext ? AGENT_BINARY_TYPES.get(ext) : undefined;

  const declaredExt = AGENT_BINARY_EXTENSIONS.get(mime);
  if (declaredExt) {
    if (parts && extType === mime) {
      return { fileName: `${parts.base}.${ext}`, contentType: mime, kind: 'binary' };
    }
    const base = parts && extType ? parts.base : fileName;
    return { fileName: `${base}.${declaredExt}`, contentType: mime, kind: 'binary' };
  }
  if (parts && extType) {
    return { fileName: `${parts.base}.${ext}`, contentType: extType, kind: 'binary' };
  }

  if (parts && ext === 'eml') return emailAsText(parts.base);
  if (parts && ext && TEXT_EXTENSIONS.has(ext)) {
    if (mime.startsWith('video/') || mime.startsWith('audio/')) return null;
    return {
      fileName: `${parts.base}.${ext}`,
      contentType: textContentType(mime, contentType),
      kind: 'text',
    };
  }

  if (mime === 'message/rfc822') return emailAsText(fileName);
  return isTextual(mime)
    ? { fileName, contentType: textContentType(mime, contentType), kind: 'text' }
    : null;
}

/**
 * BOM-marked UTF-16 as UTF-8; anything else unchanged. The framework tries
 * UTF-8 then Windows-1252, so UTF-16 would reach the model with a NUL
 * between letters.
 */
export function toUtf8(data: Uint8Array): Uint8Array {
  const order =
    data[0] === 0xff && data[1] === 0xfe
      ? 'utf-16le'
      : data[0] === 0xfe && data[1] === 0xff
        ? 'utf-16be'
        : undefined;
  if (!order) return data;
  // Bun's types omit these labels; the runtime decodes both. TextDecoder
  // drops the byte-order mark.
  const decoder = new TextDecoder(order as ConstructorParameters<typeof TextDecoder>[0]);
  return new TextEncoder().encode(decoder.decode(data));
}

/**
 * Whether bytes meant to be read as text look like text: no gzip or zip
 * signature and no NUL byte in the first 8 KiB. UTF-16 (which has NUL
 * bytes) is recognized by its byte-order mark.
 */
export function looksLikeText(data: Uint8Array): boolean {
  const head = data.subarray(0, 8192);
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return true;
  if (head[0] === 0x1f && head[1] === 0x8b) return false;
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return false;
  return !head.includes(0);
}

/**
 * The prompt text that stands in for an attachment agents can't read, so
 * the agent knows a file was sent and can ask for a format it reads instead
 * of answering as if nothing was attached.
 */
export function unsupportedAttachmentNote(fileName: string): string {
  return (
    `[Attachment "${fileName}" was not included: this file type can't be read. ` +
    'Supported: images (JPEG, PNG, GIF, WebP), PDF, Word (.docx), Excel (.xlsx) and text files.]'
  );
}

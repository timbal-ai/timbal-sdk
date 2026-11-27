/**
 * Which inbound attachments Timbal agents can read.
 *
 * The agent framework infers a file's type from its URL's extension (the
 * temp-file URL keeps the uploaded file name) and turns images, PDFs, Word
 * and Excel files into model input. Anything else is decoded as text — fine
 * for text files, but a binary file (pptx, zip, HEIC, ...) becomes bytes of
 * garbage in the prompt, and a large one overflows the model's context and
 * fails the run.
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
  'sql', 'graphql', 'eml', 'ics', 'vcf', 'srt', 'vtt', 'tex',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'go', 'rs', 'rb',
  'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'scala', 'r', 'lua',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'css', 'scss', 'vue', 'svelte',
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

/** Splits `Report.DOCX` into `Report` and `docx`; no extension → `undefined`. */
function splitExtension(fileName: string): { base: string; ext: string } | undefined {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return undefined;
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot + 1).toLowerCase() };
}

/** The name and content type to upload an attachment under. */
export interface AgentReadableUpload {
  fileName: string;
  contentType: string;
}

/**
 * The name and content type to upload an attachment under so an agent can
 * read it, or `null` when agents can't (the attachment should be skipped).
 *
 * The framework picks Word, Excel and email handling by a case-sensitive
 * extension match, and the type the file is served with decides images and
 * PDFs. So:
 *
 * - A name with a supported extension is kept, with the extension
 *   lowercased (`Report.DOCX` → `Report.docx`).
 * - A supported binary file is uploaded with its standard content type: the
 *   declared one when that is a supported type, else the extension's
 *   (`photo.jpg` + `image/jpg` or `application/octet-stream` → `image/jpeg`).
 * - A name without a supported extension gets the one of its supported
 *   content type (`report` + `application/pdf` → `report.pdf`).
 * - Other text keeps its name, recognized by its content type: the framework
 *   decodes it as text.
 */
export function agentReadableUpload(
  fileName: string,
  contentType: string,
): AgentReadableUpload | null {
  const mime = normalizeMime(contentType);
  const declaredExt = AGENT_BINARY_EXTENSIONS.get(mime);
  const parts = splitExtension(fileName);

  const extType = parts && AGENT_BINARY_TYPES.get(parts.ext);
  if (parts && extType) {
    return {
      fileName: `${parts.base}.${parts.ext}`,
      contentType: declaredExt ? mime : extType,
    };
  }
  if (parts && TEXT_EXTENSIONS.has(parts.ext)) {
    return { fileName: `${parts.base}.${parts.ext}`, contentType };
  }

  if (declaredExt) return { fileName: `${fileName}.${declaredExt}`, contentType: mime };

  return isTextual(mime) ? { fileName, contentType } : null;
}

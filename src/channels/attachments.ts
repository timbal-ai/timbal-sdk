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
const AGENT_BINARY_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

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

function extensionOf(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : undefined;
}

/**
 * The file name to upload an attachment under so an agent can read it, or
 * `null` when agents can't (the attachment should be skipped).
 *
 * - A name with a supported binary extension is kept.
 * - A name without one gets the extension of its supported content type
 *   (`report` + `application/pdf` → `report.pdf`).
 * - Text keeps its name, recognized by its extension or its content type:
 *   the framework decodes it as text.
 */
export function agentReadableFileName(fileName: string, contentType: string): string | null {
  const ext = extensionOf(fileName);
  if (ext && (ext in AGENT_BINARY_TYPES || TEXT_EXTENSIONS.has(ext))) return fileName;

  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  const typeExt = Object.keys(AGENT_BINARY_TYPES).find((e) => AGENT_BINARY_TYPES[e] === mime);
  if (typeExt) return `${fileName}.${typeExt}`;

  return isTextual(mime) ? fileName : null;
}

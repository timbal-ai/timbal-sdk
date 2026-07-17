import type { WorkforceEvent } from '../lib/workforce/events';

/**
 * A file the agent attached to its reply. `file` is how the Timbal runtime
 * serializes a `File`: the persisted platform URL when the file was
 * persisted, otherwise a `data:<mime>;base64,...` URL.
 */
export interface ReplyFile {
  file: string;
  fileName?: string;
}

/**
 * Accumulates the user-facing reply text out of a workforce SSE stream.
 *
 * Understands the Timbal Python runtime's event vocabulary (both local
 * `timbal start` and platform deployments run the same runtime):
 *
 * - `DELTA` + `item.text_delta` — streamed LLM text; appended.
 * - `CHUNK` + string `chunk` — legacy untyped streaming; appended.
 * - `OUTPUT` (top-level only, i.e. `path` without a dot) — the definitive
 *   result. Supersedes everything accumulated: extracts a plain string
 *   output directly, or joins the `text` blocks of a Message-shaped
 *   `{ content: [...] }` output. `file` blocks in that content are
 *   collected into {@link files} (they never stream as deltas). Nested
 *   OUTPUTs (tools, sub-steps — dotted paths like `agent.get_datetime`)
 *   are ignored.
 * - Lowercase `delta` / `output` — tolerated for custom components that
 *   emit simplified events.
 *
 * Everything else (START, tool_use deltas, thinking, heartbeats) is skipped.
 */
export class WorkforceTextCollector {
  private accumulated = '';
  private finalText: string | null = null;
  private replyFiles: ReplyFile[] = [];

  /**
   * Feed one event. Returns the current best text when this event changed
   * it, or `null` when the event carried no reply text (callers can use the
   * return value to drive streaming updates without re-diffing).
   */
  push(ev: WorkforceEvent): string | null {
    const type = ev.type;

    if (type === 'DELTA') {
      const item = ev.item as { type?: string; text_delta?: string } | undefined;
      if (item?.type === 'text_delta' && typeof item.text_delta === 'string') {
        this.accumulated += item.text_delta;
        return this.text;
      }
      return null;
    }

    if (type === 'CHUNK' && typeof ev.chunk === 'string') {
      this.accumulated += ev.chunk;
      return this.text;
    }

    if (type === 'OUTPUT') {
      // Only the top-level runnable's OUTPUT is the reply; nested steps
      // (dotted paths) emit their own OUTPUTs with tool results.
      const path = typeof ev.path === 'string' ? ev.path : '';
      if (path.includes('.')) return null;
      this.replyFiles = extractOutputFiles(ev.output);
      const extracted = extractOutputText(ev.output);
      if (extracted !== null) {
        this.finalText = extracted;
        return this.text;
      }
      return null;
    }

    // Simplified lowercase vocabulary (custom/non-runtime components).
    if (type === 'delta' && typeof ev.delta === 'string') {
      this.accumulated += ev.delta;
      return this.text;
    }
    if (type === 'output' && typeof ev.output === 'string' && ev.output) {
      this.finalText = ev.output;
      return this.text;
    }

    return null;
  }

  /** Best known reply text right now: the final OUTPUT if seen, else the accumulation. */
  get text(): string {
    return this.finalText ?? this.accumulated;
  }

  /** Files attached to the reply (from the top-level OUTPUT). */
  get files(): ReplyFile[] {
    return this.replyFiles;
  }
}

/**
 * Pull display text out of an OUTPUT event's `output` field: a plain string,
 * or a Message-shaped object whose `content` array carries `text` blocks.
 * Returns `null` when there's nothing textual to show.
 */
function extractOutputText(output: unknown): string | null {
  if (typeof output === 'string') return output || null;
  if (output && typeof output === 'object') {
    const content = (output as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (block): block is { type: string; text: string } =>
            !!block &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string',
        )
        .map((block) => block.text)
        .join('\n')
        .trim();
      return text || null;
    }
  }
  return null;
}

/**
 * Pull `{type:'file'}` blocks out of an OUTPUT event's Message-shaped
 * `output`. The runtime serializes `FileContent` as
 * `{ type: 'file', file: <url-or-data-url string>, name?: string }`.
 */
function extractOutputFiles(output: unknown): ReplyFile[] {
  if (!output || typeof output !== 'object') return [];
  const content = (output as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const files: ReplyFile[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const { type, file, name } = block as { type?: unknown; file?: unknown; name?: unknown };
    if (type !== 'file' || typeof file !== 'string' || !file) continue;
    files.push({ file, fileName: typeof name === 'string' && name ? name : undefined });
  }
  return files;
}

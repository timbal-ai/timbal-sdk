import type { ApiClient } from '../api';
import type {
  AnthropicToolSpec,
  OpenAIToolSpec,
  RemoteToolDetail,
  ToolResultContent,
  ToolRunOptions,
  ToolSpecFormat,
  ToolUseContent,
} from '../../types';
import { executeToolProxy, getToolDetail, listToolManifest } from '../functions/tools';
import { RemoteTool } from './remote-tool';

interface ToolListOptions {
  orgId?: string;
  /** Filter to a single provider (join key to `integrations`). */
  provider?: string;
}

/**
 * Framework-tool execution plane — reached via `timbal.tools`.
 *
 * The complement to `timbal.integrations` (the credential plane): tools are the
 * *actions* you run; integrations are the *connections* they consume. A tool's
 * `provider` is the join key between them.
 *
 * - `run(ref, input, opts?)` — fire a tool by name/handle (no manifest round-trip).
 * - `list()` — lightweight descriptors (metadata, no schema) from the manifest.
 * - `get(ref)` — one descriptor with its parameter schema hydrated (detail call).
 * - `specs({ format })` — manifest tools serialized to OpenAI/Anthropic specs.
 * - `dispatch(toolUse, opts?)` — model `tool_use` → proxy → `tool_result`.
 *
 * The manifest list is cached per `orgId`; invalidate with {@link clearCache}.
 */
export class ToolsSection {
  private listCache = new Map<string, RemoteTool[]>();

  constructor(private readonly apiClient: ApiClient) {}

  /**
   * Execute a tool via the proxy. Escape hatch that skips the manifest — use
   * when you already know the tool name/handle and params.
   */
  run<T = unknown>(
    name: string,
    input: Record<string, unknown>,
    opts?: ToolRunOptions,
  ): Promise<T> {
    return executeToolProxy<T>(this.apiClient, name, input, opts);
  }

  /** List declarative tool descriptors (metadata only) from the manifest (cached per org). */
  async list(opts?: ToolListOptions): Promise<RemoteTool[]> {
    const org = opts?.orgId || this.apiClient.getConfig().orgId || '';
    const key = `${org}:${opts?.provider ?? ''}`;
    const cached = this.listCache.get(key);
    if (cached) return cached;

    const specs = await listToolManifest(this.apiClient, {
      ...(opts?.orgId && { orgId: opts.orgId }),
      ...(opts?.provider && { provider: opts.provider }),
    });
    const tools = specs.map((s) => new RemoteTool(this.apiClient, s));
    this.listCache.set(key, tools);
    return tools;
  }

  /**
   * Get one tool with its parameter schema hydrated (detail endpoint).
   * @throws {TimbalApiError} 404 when no tool with that name is registered.
   */
  async get(name: string, opts?: { orgId?: string }): Promise<RemoteTool> {
    const detail: RemoteToolDetail = await getToolDetail(this.apiClient, name, opts);
    return RemoteTool.fromDetail(this.apiClient, detail);
  }

  /** Serialize tools to OpenAI function-tool specs (schemas hydrated via detail). */
  async specs(opts: { format: 'openai'; tools?: string[] } & ToolListOptions): Promise<OpenAIToolSpec[]>;
  /** Serialize tools to Anthropic tool specs (schemas hydrated via detail). */
  async specs(opts: { format: 'anthropic'; tools?: string[] } & ToolListOptions): Promise<AnthropicToolSpec[]>;
  async specs(
    opts: { format: ToolSpecFormat; tools?: string[] } & ToolListOptions,
  ): Promise<OpenAIToolSpec[] | AnthropicToolSpec[]> {
    // Resolve the target set: explicit names (including `[]`) > whole manifest.
    const names =
      opts.tools !== undefined ? opts.tools : (await this.list(opts)).map((t) => t.name);

    const tools = await Promise.all(names.map((n) => this.get(n, opts)));
    return opts.format === 'anthropic'
      ? tools.map((t) => t.toAnthropic())
      : tools.map((t) => t.toOpenAI());
  }

  /**
   * Agent-loop glue. Runs the tool named by a model's `tool_use` block via the
   * proxy and wraps the result as a `tool_result` keyed to the same id.
   */
  async dispatch(toolUse: ToolUseContent, opts?: ToolRunOptions): Promise<ToolResultContent> {
    const result = await this.run<unknown>(toolUse.name, toolUse.input, {
      ...opts,
      callId: opts?.callId ?? toolUse.id,
    });
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return {
      type: 'tool_result',
      id: toolUse.id,
      content: [{ type: 'text', text }],
    };
  }

  /** Invalidate the manifest cache (call after registering new tools server-side). */
  clearCache(): void {
    this.listCache.clear();
  }
}

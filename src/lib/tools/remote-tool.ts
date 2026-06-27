import type { ApiClient } from '../api';
import type {
  AnthropicToolSpec,
  JSONSchema,
  OpenAIToolSpec,
  RemoteToolDetail,
  RemoteToolSpec,
  ToolRunOptions,
} from '../../types';
import { executeToolProxy, getToolDetail } from '../functions/tools';

const EMPTY_SCHEMA: JSONSchema = { type: 'object', properties: {} };

/**
 * A declarative, named framework tool — the unit an agent calls by name.
 *
 * Constructed from a manifest list row ({@link RemoteToolSpec}): identity +
 * metadata, but **no parameter schema** until {@link load} fetches the detail
 * (`GET /proxies/v1/tools/{name}`). Provides:
 * - `run()` — execute via the proxy (credentials stay server-side);
 * - `load()` — hydrate `parameters` from the detail endpoint;
 * - `toOpenAI()` / `toAnthropic()` — function-tool specs (call `load()` first
 *   for a populated schema; otherwise the schema is empty).
 *
 * `provider` is the join key back to `timbal.integrations`.
 */
export class RemoteTool {
  readonly name: string;
  readonly description: string;
  readonly provider?: string;
  readonly providerLogo?: string;
  readonly className?: string;
  readonly available?: boolean;
  readonly serviceAccountEligible?: boolean;
  readonly connection?: string;

  /** Populated by {@link load}; `undefined` on a list-only descriptor. */
  parameters?: JSONSchema;

  constructor(
    private readonly apiClient: ApiClient,
    spec: RemoteToolSpec,
  ) {
    this.name = spec.name;
    this.description = spec.description ?? '';
    if (spec.provider) this.provider = spec.provider;
    if (spec.provider_logo) this.providerLogo = spec.provider_logo;
    if (spec.class_name) this.className = spec.class_name;
    if (spec.available !== undefined) this.available = spec.available;
    if (spec.service_account_eligible !== undefined) {
      this.serviceAccountEligible = spec.service_account_eligible;
    }
    if (spec.connection) this.connection = spec.connection;
  }

  /** Build a fully-hydrated tool straight from a detail payload. */
  static fromDetail(apiClient: ApiClient, detail: RemoteToolDetail): RemoteTool {
    const tool = new RemoteTool(apiClient, {
      name: detail.tool,
      description: detail.description ?? '',
      ...(detail.provider && { provider: detail.provider }),
      ...(detail.class_name && { class_name: detail.class_name }),
    });
    tool.parameters = detail.params ?? EMPTY_SCHEMA;
    return tool;
  }

  /** Execute this tool via the platform proxy. See {@link executeToolProxy}. */
  run<T = unknown>(input: Record<string, unknown>, opts?: ToolRunOptions): Promise<T> {
    return executeToolProxy<T>(this.apiClient, this.name, input, opts);
  }

  /** Hydrate `parameters` from the detail endpoint. Returns `this` for chaining. */
  async load(opts?: { orgId?: string }): Promise<this> {
    const detail = await getToolDetail(this.apiClient, this.name, opts);
    this.parameters = detail.params ?? EMPTY_SCHEMA;
    return this;
  }

  /** OpenAI chat-completions function-tool spec. Call {@link load} first for a real schema. */
  toOpenAI(): OpenAIToolSpec {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters ?? EMPTY_SCHEMA,
      },
    };
  }

  /** Anthropic Messages API tool spec. Call {@link load} first for a real schema. */
  toAnthropic(): AnthropicToolSpec {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.parameters ?? EMPTY_SCHEMA,
    };
  }
}

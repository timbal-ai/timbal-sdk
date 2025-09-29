import {
  Message,
  MessageContent,
  MessageRole,
  TextContent,
  ThinkingContent,
  FileContent,
} from "../types";

export class TimbalMessage implements Message {
  public readonly role: MessageRole;
  public readonly content: MessageContent[];

  constructor(role: MessageRole, content: MessageContent[]) {
    this.role = role;
    this.content = content;
  }

  /**
   * Extracts and concatenates all text content from the message
   */
  collectText(): string {
    return this.content
      .filter((content): content is TextContent => content.type === "text")
      .map(content => content.text)
      .join("\n\n") + (this.content.some(c => c.type === "text") ? "\n\n" : "");
  }

  /**
   * Creates a TimbalMessage from various input types
   */
  static from(value: unknown): TimbalMessage {
    if (value instanceof TimbalMessage) {
      return value;
    }

    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      const role = (obj.role as MessageRole) || "user";
      let content = obj.content;

      if (!Array.isArray(content)) {
        content = [content];
      }

      const processedContent = (content as unknown[]).map((item: unknown) => MessageContentFactory.from(item));
      return new TimbalMessage(role, processedContent);
    }

    // For primitives, create a user message with text content
    return new TimbalMessage("user", [MessageContentFactory.from(value)]);
  }
}

/**
 * Factory class for creating MessageContent from various input types
 */
export abstract class MessageContentFactory {
  /**
   * Creates MessageContent from various input types
   */
  static from(value: unknown): MessageContent {
    // Handle already-typed content (except tool_result which needs special processing)
    if (typeof value === "object" && value !== null && "type" in value && value.type !== "tool_result") {
      return value as MessageContent;
    }

    // Handle strings
    if (typeof value === "string") {
      return { type: "text", text: value };
    }

    // Handle objects with type property
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      const contentType = obj.type;

      switch (contentType) {
        case "text":
          return { type: "text", text: String(obj.text || "") };

        case "thinking":
          return { type: "thinking", thinking: String(obj.thinking || "") };

        case "file":
          return { type: "file", file: String(obj.file || "") };

        case "tool_use":
          return {
            type: "tool_use",
            id: String(obj.id || ""),
            name: String(obj.name || ""),
            input: (obj.input as Record<string, unknown>) || {},
          };

        case "tool_result": {
          let toolResultContent = obj.content;
          if (!Array.isArray(toolResultContent)) {
            toolResultContent = [toolResultContent];
          }
          const processedContent = (toolResultContent as unknown[])
            .map((item: unknown) => MessageContentFactory.from(item))
            .filter((content): content is TextContent | ThinkingContent | FileContent =>
              content.type === "text" || content.type === "thinking" || content.type === "file"
            );
          return {
            type: "tool_result",
            id: String(obj.id || ""),
            content: processedContent,
          };
        }

        default:
          // For objects without a recognized type, stringify them
          return { type: "text", text: JSON.stringify(obj) };
      }
    }

    // For all other types (numbers, booleans, etc.), convert to string
    return { type: "text", text: String(value) };
  }
}
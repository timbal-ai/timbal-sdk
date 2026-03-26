/**
 * Parse a single SSE data line into a plain object.
 *
 * Handles both standard JSON and Python dict repr (single quotes, None, True, False)
 * which is what the Timbal codegen endpoint emits.
 *
 * Returns null for empty lines, [DONE] sentinels, and unparseable data.
 */
export function parseSSELine(line: string): Record<string, unknown> | null {
  let data = line.trim();
  if (!data) return null;
  if (data.startsWith("data: ")) data = data.substring(6);
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    // Fallback: handle Python dict repr (single quotes, None, True, False)
    try {
      const fixed = data
        .replace(/'/g, '"')
        .replace(/\bNone\b/g, "null")
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false");
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

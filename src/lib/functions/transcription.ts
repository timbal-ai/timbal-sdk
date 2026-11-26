import type { ApiClient } from '../api/client';

/** Result of {@link transcribeAudio}. */
export interface Transcription {
  /** The spoken text. Empty when nothing was recognized. */
  text: string;
}

/**
 * Transcription time grows with the audio's length (a 16 MB voice note is
 * many minutes), so the client's default request timeout is too short.
 */
export const TRANSCRIPTION_TIMEOUT_MS = 5 * 60_000;

/**
 * Transcribe an audio file (speech to text) with the Timbal platform's
 * transcription service (`POST /orgs/{org}/transcriptions`, up to 50 MB).
 *
 * Billed to the client's org and attributed to its project when one is
 * configured (`TIMBAL_PROJECT_ID` on deployed projects).
 *
 * Waits up to {@link TRANSCRIPTION_TIMEOUT_MS} (or the client's timeout, if
 * longer) and is sent once: each attempt is billed, so a timeout or 5xx is
 * not retried.
 *
 * @example
 * const { text } = await transcribeAudio(client, bytes, 'voice.ogg', 'audio/ogg');
 */
export async function transcribeAudio(
  client: ApiClient,
  data: ArrayBuffer | Uint8Array,
  filename: string,
  contentType: string,
): Promise<Transcription> {
  const { orgId, projectId, timeout } = client.getConfig();
  if (!orgId) {
    throw new Error('orgId is required to transcribe audio.');
  }
  const formData = new FormData();
  formData.append('file', new Blob([data], { type: contentType }), filename);
  const headers: Record<string, string> = projectId
    ? { 'x-timbal-project-id': String(projectId) }
    : {};
  const response = await client.postFormData<{ text?: unknown }>(
    `orgs/${orgId}/transcriptions`,
    formData,
    headers,
    { timeout: Math.max(timeout, TRANSCRIPTION_TIMEOUT_MS), retryAttempts: 0 },
  );
  const text = response.data?.text;
  return { text: typeof text === 'string' ? text : '' };
}

import type { ApiClient } from '../api/client';

/** Result of {@link transcribeAudio}. */
export interface Transcription {
  /** The spoken text. Empty when nothing was recognized. */
  text: string;
}

/**
 * Transcribe an audio file (speech to text) with the Timbal platform's
 * transcription service (`POST /orgs/{org}/transcriptions`, up to 50 MB).
 *
 * Billed to the client's org and attributed to its project when one is
 * configured (`TIMBAL_PROJECT_ID` on deployed projects).
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
  const { orgId, projectId } = client.getConfig();
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
  );
  const text = response.data?.text;
  return { text: typeof text === 'string' ? text : '' };
}

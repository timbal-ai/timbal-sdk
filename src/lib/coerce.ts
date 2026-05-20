/**
 * Boundary types + coercion helpers. **Internal**, not part of the public API.
 *
 * The server emits `int64` IDs as JSON numbers on some routes. The SDK exposes
 * every `id` as `string` (matches the rest of the surface and avoids precision
 * surprises with `Number.MAX_SAFE_INTEGER`). This module is where we collapse
 * `string | number` → `string` at the wire boundary so callers never see the
 * raw shape.
 *
 * The `Raw*` types are spelled `Omit<T, 'id'|...> & { id: string|number, ... }`
 * (not `T & { id: string|number }`) because TS computes intersections
 * per-field: `string & (string | number) = string`, which would silently
 * collapse the union and let a future janitor PR delete the `String()` call
 * trusting the type. The `Omit` keeps `raw.id` honestly `string | number`.
 *
 * See `src/__tests__/coerce-raw-id.typecheck.ts` for the compile-time
 * assertion that locks this in.
 */

import type {
  KbInfo,
  K2File,
  K2FileDetail,
  K2FileEmbedding,
  K2FileParsing,
  Project,
  WorkforceItem,
  WorkforcePreview,
} from '../types';

/** `string` if defined, `undefined` if input is null/undefined. */
function toStringIdOpt(v: string | number | null | undefined): string | undefined {
  return v == null ? undefined : String(v);
}

/** `string` always. Throws on null/undefined to match required-field semantics. */
function toStringId(v: string | number | null | undefined): string {
  if (v == null) throw new Error('coerce: required id was null/undefined');
  return String(v);
}

// ── Project ────────────────────────────────────────────────────────────────

export type RawWorkforcePreview =
  & Omit<WorkforcePreview, 'id' | 'uid'>
  & { id: string | number; uid: string | number | null };

export type RawProject =
  & Omit<Project, 'id' | 'workforce'>
  & { id: string | number; workforce?: RawWorkforcePreview[] };

/**
 * Wire shape for `GET /orgs/{org}/projects/{id}` and `GET /me?project_id=...`.
 * The backend historically returned `apps`; the current contract is
 * `workforce`. Accept both.
 */
export type RawProjectResponse =
  & Omit<RawProject, 'workforce'>
  & { workforce?: RawWorkforcePreview[]; apps?: RawWorkforcePreview[] };

export function coerceWorkforcePreview(raw: RawWorkforcePreview): WorkforcePreview {
  return { ...raw, id: toStringId(raw.id), uid: toStringIdOpt(raw.uid) ?? null };
}

export function coerceProject(raw: RawProject): Project {
  return {
    ...raw,
    id: toStringId(raw.id),
    workforce: (raw.workforce ?? []).map(coerceWorkforcePreview),
  };
}

/**
 * Coerce a project response that may carry the legacy `apps` alias. Folds
 * `apps` into `workforce` (workforce wins when both are present) before
 * delegating to {@link coerceProject}.
 *
 * Note: `apps` is destructured out, not spread through — otherwise it would
 * survive on the returned `Project` as a hidden runtime property holding
 * uncoerced numeric ids, even though `Project` doesn't declare the field.
 * TypeScript's structural typing would let that leak silently.
 */
export function coerceProjectResponse(raw: RawProjectResponse): Project {
  const { apps, workforce, ...rest } = raw;
  return coerceProject({
    ...rest,
    workforce: workforce ?? apps ?? [],
  });
}

// ── KB collection ──────────────────────────────────────────────────────────

export type RawKbInfo =
  & Omit<KbInfo, 'id' | 'uid'>
  & { id: string | number; uid: string | number };

export function coerceKbInfo(raw: RawKbInfo): KbInfo {
  // Cast: KbInfo carries a `[key: string]: unknown` index signature that
  // confuses the spread + Omit intersection. Runtime preserves every field.
  return { ...raw, id: toStringId(raw.id), uid: toStringId(raw.uid) } as KbInfo;
}

// ── KB files ───────────────────────────────────────────────────────────────

export type RawK2File =
  & Omit<K2File, 'id' | 'uid' | 'kb_id'>
  & { id: string | number; uid: string | number; kb_id: string | number };

export type RawK2FileParsing =
  & Omit<K2FileParsing, 'id' | 'kb_file_id'>
  & { id: string | number; kb_file_id: string | number };

export type RawK2FileEmbedding =
  & Omit<K2FileEmbedding, 'id' | 'kb_file_id' | 'parsing_id'>
  & { id: string | number; kb_file_id: string | number; parsing_id?: string | number | null };

export type RawK2FileDetail =
  & RawK2File
  & { parsings: RawK2FileParsing[]; embeddings: RawK2FileEmbedding[] };

export function coerceK2File(raw: RawK2File): K2File {
  return {
    ...raw,
    id: toStringId(raw.id),
    uid: toStringId(raw.uid),
    kb_id: toStringId(raw.kb_id),
  };
}

export function coerceK2FileParsing(raw: RawK2FileParsing): K2FileParsing {
  return { ...raw, id: toStringId(raw.id), kb_file_id: toStringId(raw.kb_file_id) };
}

export function coerceK2FileEmbedding(raw: RawK2FileEmbedding): K2FileEmbedding {
  // `parsing_id` is optional+nullable on the public type. Destructure it out
  // before spreading so the raw `string | number` type doesn't survive on the
  // returned object, then conditionally re-add — keeping an absent field
  // absent (preserves `in`, `Object.keys`, and `JSON.stringify` semantics).
  const { parsing_id, ...rest } = raw;
  return {
    ...rest,
    id: toStringId(raw.id),
    kb_file_id: toStringId(raw.kb_file_id),
    ...(parsing_id !== undefined && {
      parsing_id: parsing_id === null ? null : String(parsing_id),
    }),
  };
}

export function coerceK2FileDetail(raw: RawK2FileDetail): K2FileDetail {
  return {
    ...coerceK2File(raw),
    parsings: raw.parsings.map(coerceK2FileParsing),
    embeddings: raw.embeddings.map(coerceK2FileEmbedding),
  };
}

// ── Workforce ──────────────────────────────────────────────────────────────

export type RawWorkforceItem =
  & Omit<WorkforceItem, 'id' | 'uid'>
  & { id?: string | number; uid?: string | number | null };

export function coerceWorkforceItem(raw: RawWorkforceItem): WorkforceItem {
  // Cast: spread + Omit composition over optional fields drops the narrowed
  // id type. Runtime is `string | undefined` which matches `WorkforceItem.id`.
  return {
    ...raw,
    ...(raw.id !== undefined && { id: toStringId(raw.id) }),
    ...(raw.uid !== undefined && { uid: toStringIdOpt(raw.uid) ?? null }),
  } as WorkforceItem;
}

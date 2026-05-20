// Compile-time-only assertion. Locks the boundary-type pattern across every
// Raw* in src/lib/coerce.ts: if anyone "simplifies" `Omit<T, 'id'> & { id: ... }`
// back to `T & { id: ... }`, TS collapses `string & (string | number)` → `string`
// and the String() coercion in the matching coerce* helper becomes dead code.
//
// Each @ts-expect-error below MUST fire. If the union collapses, the directive
// becomes unused and tsc errors with TS2578.

import type {
  RawKbInfo,
  RawK2File,
  RawK2FileParsing,
  RawK2FileEmbedding,
  RawWorkforceItem,
  RawWorkforcePreview,
  RawProject,
} from '../lib/coerce';

declare const kb: RawKbInfo;
declare const f: RawK2File;
declare const p: RawK2FileParsing;
declare const e: RawK2FileEmbedding;
declare const w: RawWorkforceItem;
declare const wp: RawWorkforcePreview;
declare const pr: RawProject;

// Positive: union is preserved.
const _kb_id: string | number = kb.id;
const _f_kb_id: string | number = f.kb_id;
const _p_kb_file_id: string | number = p.kb_file_id;
const _e_parsing_id: string | number | null | undefined = e.parsing_id;
const _wp_id: string | number = wp.id;
const _pr_id: string | number = pr.id;

// Negative: assigning the raw id to a plain `string` MUST fail. If any Raw*
// regresses to the collapsing form, the corresponding directive becomes unused
// and tsc fails with TS2578.

// @ts-expect-error RawKbInfo.id is `string | number`, not `string`
const _x1: string = kb.id;
// @ts-expect-error RawK2File.id is `string | number`, not `string`
const _x2: string = f.id;
// @ts-expect-error RawK2File.kb_id is `string | number`, not `string`
const _x3: string = f.kb_id;
// @ts-expect-error RawK2FileParsing.id is `string | number`, not `string`
const _x4: string = p.id;
// @ts-expect-error RawK2FileEmbedding.id is `string | number`, not `string`
const _x5: string = e.id;
// @ts-expect-error RawWorkforceItem.id is `string | number | undefined`, not `string`
const _x6: string = w.id!;
// @ts-expect-error RawWorkforcePreview.id is `string | number`, not `string`
const _x7: string = wp.id;
// @ts-expect-error RawProject.id is `string | number`, not `string`
const _x8: string = pr.id;

void _kb_id;
void _f_kb_id;
void _p_kb_file_id;
void _e_parsing_id;
void _wp_id;
void _pr_id;
void _x1; void _x2; void _x3; void _x4; void _x5; void _x6; void _x7; void _x8;

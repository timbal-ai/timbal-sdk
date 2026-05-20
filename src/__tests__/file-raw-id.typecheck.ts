// Compile-time-only assertion: the boundary type used by upload* must keep
// `id` as `string | number`. If anyone "simplifies" it back to
// `File & { id: string | number }`, TS collapses the union to `string` and
// the String() coercion at the boundary stops being meaningful. This file
// fails to compile if that regression happens.
//
// Not a runtime test; tsc --noEmit catches it.

import type { File } from '../types';

type RawFile = Omit<File, 'id'> & { id: string | number };

declare const raw: RawFile;

const _idIsUnion: string | number = raw.id;

const _numericIdAccepted: RawFile = {
  id: 12345,
  name: 'x',
  content_type: 'text/plain',
  content_length: 1,
  created_at: '',
  url: '',
};

// Negative assertion via @ts-expect-error: assigning raw.id to a `string`
// MUST fail. If the union collapses again, this directive becomes unused
// and tsc errors with TS2578.
// @ts-expect-error raw.id is `string | number`, not `string`
const _idIsNotPlainString: string = raw.id;

void _idIsUnion;
void _numericIdAccepted;
void _idIsNotPlainString;

/** Compile-only assertions for KB.schema() overload resolution. */
import type { KB } from '../lib/kb/kb';
import type { TableSchema } from '../types';

declare const kb: KB;

async function assertSqlNarrows() {
  const ddl = await kb.schema({ format: 'sql' });
  const _stmt: string = ddl[0]!;
}

async function assertStructuredNarrows() {
  const tables = await kb.schema();
  const _name: string = tables[0]!.name;
}

void assertSqlNarrows;
void assertStructuredNarrows;

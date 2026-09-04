import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { z } from 'zod'
import { catalogSectionSchema } from './schema.ts'

/** Absolute-from-repo-root path of the generated schema file. */
export const SCHEMA_PATH = 'registry/schema/plugin-entry.schema.json'

/**
 * Render the published JSON Schema for the `dsh.catalog` section.
 * @returns the exact bytes the committed schema file must contain.
 */
export function renderJsonSchema(): string {
  const schema = {
    $id: 'https://dsh-plugin-shop.dev/schema/plugin-entry.schema.json',
    title: 'dsh.catalog',
    description: 'The catalog section a dsh plugin declares in its package.json.',
    ...z.toJSONSchema(catalogSectionSchema),
  }
  return `${JSON.stringify(schema, null, 2)}\n`
}

// The write — the only real work here — belongs to the entry point alone,
// never to an import: schema.test.ts imports renderJsonSchema above to check
// the committed file is fresh, and must not rewrite it on the way past. This
// module drew that positive line first and the other four entry points now
// match it; the comparison is EXACT because `endsWith('emit-schema.ts')` also
// admits `reemit-schema.ts`. `node -e` leaves process.argv[1] undefined, so
// basename('') matches no name and a bare import writes nothing.
// registry/scripts/tests/strip-types.test.ts derives the entry-point list and
// holds every member of it to both halves of this.
if (basename(process.argv[1] ?? '') === 'emit-schema.ts') {
  writeFileSync(SCHEMA_PATH, renderJsonSchema())
  process.stdout.write(`wrote ${SCHEMA_PATH}\n`)
}

import { writeFileSync } from 'node:fs'
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

if (process.argv[1]?.endsWith('emit-schema.ts') === true) {
  writeFileSync(SCHEMA_PATH, renderJsonSchema())
  process.stdout.write(`wrote ${SCHEMA_PATH}\n`)
}

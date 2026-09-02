/** `cordis.patch.yml`'s `catalogUrl` fallback is a YAML string literal,
 * typed independently of `DEFAULT_CATALOG_URL` in `catalog.ts`. The two
 * must name the same url: a profile with no `DSH_SHOP_CATALOG_URL` set gets
 * the YAML literal, and `catalogOrigins()` (catalog.ts) compares that same
 * url against `DEFAULT_CATALOG_URL` to decide whether the mirror race runs
 * at all — a drifted fallback would silently take every such profile out of
 * the race path this whole design exists for, and nothing but a live host
 * would ever notice. README pins drifted exactly this way once with no test
 * watching (readme-pins.test.ts); this is the same drift, one file over.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DEFAULT_CATALOG_URL } from '../../src/host/catalog.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('cordis.patch.yml catalogUrl fallback', () => {
  it('names the same url as DEFAULT_CATALOG_URL', () => {
    const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
    const match = /catalogUrl: !!js process\.env\.DSH_SHOP_CATALOG_URL \?\? '([^']+)'/.exec(patch)
    // Fails loudly on a shape change too: a silently-unmatched regex would
    // make this test vacuously pass no matter what the fallback said.
    if (match === null) throw new Error('cordis.patch.yml: catalogUrl fallback expression not found or changed shape')
    expect(match[1]).toBe(DEFAULT_CATALOG_URL)
  })
})

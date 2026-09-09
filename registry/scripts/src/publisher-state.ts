/**
 * The committed memory of the npm harvest's PUBLISHER axis: every maintainer
 * username the harvest has seen on a search result, plus the grammar that
 * decides what may be one.
 *
 * `keywords:<harvest>,<refinement>` cells cannot reach a package that carries
 * only the harvest keyword; `keywords:<harvest> maintainer:<user>` cells have
 * no such blind spot, because every package has a maintainer. What they DO
 * need is to have seen the maintainer, which is why this file exists: the
 * vocabulary accumulates monotonically across runs instead of being re-derived
 * each time from a window that is a shrinking fraction of the keyword.
 *
 * A deterministic build input like `verified.yml` and `repo-state.json`:
 * committed daily, sorted by code unit, and a malformed one throws rather than
 * silently harvesting with half a partition.
 *
 * PURE, and the grammar lives here rather than in `npm-client.ts` for that
 * reason: it is a policy decision, the core owns those, and no pure module in
 * this repo imports from the shell.
 */

/**
 * Bound on a maintainer username. npm's own limit is smaller, but this value
 * is interpolated into a search `text=` parameter, so the bound is ours and
 * {@link isMaintainerName}'s grammar is what actually keeps it safe.
 */
export const MAINTAINER_MAX_LENGTH = 64

/** npm account grammar: lowercase letters, digits, hyphen, underscore, dot. */
const MAINTAINER_NAME = /^[a-z0-9._-]+$/

/** Whether `value` may be put in a query as a `maintainer:` argument. */
export function isMaintainerName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAINTAINER_MAX_LENGTH
    && MAINTAINER_NAME.test(value)
}

/** Every maintainer username the harvest has seen, sorted, unique. */
export interface PublisherState {
  readonly publishers: readonly string[]
}

/**
 * Parse the committed file.
 * @throws when it is not an object with a `publishers` array of usernames this
 *   module would itself have written. Unknown keys are ignored, so an older
 *   reader does not refuse a newer file.
 */
export function parsePublisherState(raw: string): PublisherState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Named, not swallowed: JSON.parse throws here for exactly one reason and
    // the caller needs the file named, not a bare SyntaxError.
    throw new Error('publisher-state.json is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('publisher-state.json must be an object')
  }
  const publishers = (parsed as { publishers?: unknown }).publishers
  if (!Array.isArray(publishers)) {
    throw new Error('publisher-state.json: publishers must be an array')
  }
  const out: string[] = []
  publishers.forEach((name, i) => {
    if (!isMaintainerName(name)) {
      throw new Error(`publisher-state.json: publishers[${i}] is not a maintainer username`)
    }
    out.push(name)
  })
  return { publishers: out.sort() }
}

/** Serialize, sorted by code unit and newline-terminated. */
export function serializePublisherState(state: PublisherState): string {
  return `${JSON.stringify({ publishers: [...state.publishers].sort() }, null, 2)}\n`
}

/** The state plus everything in `seen`, unique and sorted. Never removes. */
export function mergePublishers(state: PublisherState, seen: Iterable<string>): PublisherState {
  return { publishers: [...new Set([...state.publishers, ...seen])].sort() }
}

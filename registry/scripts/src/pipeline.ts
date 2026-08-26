import { gate } from './gate.ts'
import { assignTier } from './tier.ts'
import { emit, type Artifacts, type StarsPointer } from './emit.ts'
import type { RegistryConfig } from './config.ts'
import type { Candidate, Entry, Rejection } from './types.ts'

/**
 * Run the whole catalog build as a pure function.
 *
 * Purity is what makes the determinism test possible: the only inputs are the
 * candidates, the registry files, and the timestamp, so the same three
 * produce byte-identical artifacts regardless of candidate order or clock.
 * @param candidates - packages fetched from npm, in any order.
 * @param config - the human-authored registry files.
 * @param builtAt - ISO 8601 build timestamp.
 * @param preexistingRejections - rejections decided before this function ran, such as a
 *   name that could not be turned into a candidate at all (e.g. a failed fetch); merged
 *   into the emitted report alongside every rejection this function produces itself.
 * @param stars - optional pointer to a published stars sidecar, passed through to emit.
 * @returns the artifacts to publish and commit.
 */
export function runPipeline(
  candidates: Candidate[],
  config: RegistryConfig,
  builtAt: string,
  preexistingRejections: Rejection[] = [],
  stars: StarsPointer | null = null,
): Artifacts {
  const entries: Entry[] = []
  const rejections: Rejection[] = [...preexistingRejections]
  for (const candidate of candidates) {
    const result = gate(candidate, config)
    if (result.ok) entries.push(assignTier(result.accepted, config))
    else rejections.push(result.rejection)
  }
  return emit(entries, rejections, builtAt, stars)
}

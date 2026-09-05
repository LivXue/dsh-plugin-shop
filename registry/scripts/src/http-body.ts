/**
 * The single capped body reader, shared by both network clients.
 *
 * Impure only in that it consumes a `Response`: no clock, no filesystem, no
 * environment, and it never initiates a request of its own.
 */

/**
 * Read a response body with a hard BYTE cap, returning null the moment it
 * exceeds `cap`. The one body reader in the project, and the one place any of
 * the four caps is enforced.
 *
 * It is shared rather than written per caller because the readers had already
 * drifted apart in the way that matters: this loop, written for the tarball,
 * cancels as soon as the cap trips, while the manifest's `await
 * response.text()` buffered the WHOLE decompressed body and then measured it.
 * `content-length` cannot stand in for the measurement — on
 * raw.githubusercontent.com it is the gzip-compressed size, so a manifest
 * whose header says 744 bytes can decode to a gigabyte — which is why the
 * count that decides is the one taken here, off the bytes as they arrive.
 *
 * It moved out of github-client.ts when the npm half needed the same bound:
 * that module capped every body it read while npm-client capped none, and
 * the plan for closing that gap proposed a third copy of this loop. The
 * drift this comment already records is the argument against writing one.
 * @param response - an `ok` response whose body is to be read.
 * @param cap - the largest body, in bytes, the caller will hold.
 * @returns the bytes, or null when the body is larger than `cap`.
 */
export async function readCappedBody(response: Response, cap: number): Promise<Uint8Array | null> {
  const body = response.body
  if (body == null) {
    // No readable stream (or a fixture that only fakes `arrayBuffer`): one
    // shot, then measured. A throw here belongs to the caller — the tarball
    // probe degrades to null, readManifest calls it an unreadable body — so it
    // is deliberately not swallowed at this level, which would leave neither
    // of them able to tell "empty" from "broken".
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > cap ? null : bytes
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        // Stop pulling the rest of the body: over the cap, refuse.
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

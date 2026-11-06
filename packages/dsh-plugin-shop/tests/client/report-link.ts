/**
 * The prefilled issue body a failure report's URL carries, decoded.
 *
 * Shared by the builder's own tests (`present.test.ts`) and the rendered ones
 * (`ShopTab.client.spec.tsx`), so a change to the link's shape is one edit
 * rather than one per reader.
 */
export function reportBodyOf(url: string | null): string {
  return new URL(url ?? 'about:blank').searchParams.get('body') ?? ''
}

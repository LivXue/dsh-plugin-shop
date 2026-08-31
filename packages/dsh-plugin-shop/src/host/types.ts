/** Wire and catalog types for the shop Host half (§6.2, §7.3). */

export interface CatalogSummary { en: string; zh?: string }

export interface CatalogSection {
  category: 'tool' | 'provider' | 'ui' | 'workflow' | 'integration' | 'other'
  summary: CatalogSummary
  capabilities: string[]
}

export interface CatalogEntry {
  name: string
  version: string
  integrity: string | null
  publishedAt: string | null
  repository: string | null
  license: string | null
  tier: 'verified' | 'verified-stale' | 'community'
  metadata: 'declared' | 'derived'
  review?: {
    reviewedVersion?: string
    reviewedCommit?: string
    reviewer: string
    reviewCommit: string
    notes: string
  }
  catalog?: CatalogSection
  /** Where the entry installs from. */
  source: 'npm' | 'github'
  /** `owner/slug`; present exactly when `source` is github. */
  repo?: string
  /** Subpackage directory inside the repo; present exactly when the entry is
   * a monorepo subpackage rather than the repo root. */
  subdir?: string
}

export interface DeniedEntry { name: string; detail: string }

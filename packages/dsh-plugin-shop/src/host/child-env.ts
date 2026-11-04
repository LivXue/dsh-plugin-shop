/**
 * The environment an install command is spawned with (design
 * 2026-11-04-borrowings-round-4 §1).
 *
 * One function so the two spawns that run package-manager work — the CLI
 * install in `executor.ts` and the download lane in `prefetch.ts` — cannot
 * drift: a setting that reaches one and not the other would fix a hang on one
 * path and leave it on the other.
 */

/**
 * `env` with the settings a headless spawn needs.
 *
 * - `GIT_TERMINAL_PROMPT=0`: a dependency fetched from a private git remote
 *   would otherwise stop at a username prompt. The child has no console to
 *   answer it, so the install hangs until `INSTALL_TIMEOUT_MS` and reports a
 *   timeout — the wrong cause, and fifteen minutes of a reader's time. dsh's
 *   own spawn does not set this; measured on the competitor's own bug (their
 *   #1094, a visible terminal window from a detached child), the class is
 *   real on Windows.
 * - `GCM_INTERACTIVE=never`: Git for Windows ships Git Credential Manager as
 *   the default helper, and it ignores `GIT_TERMINAL_PROMPT` — on a cache miss
 *   it opens its own GUI window and waits. `never` still resolves a stored
 *   credential and fails fast instead of prompting. An inherited `GIT_ASKPASS`
 *   is the same residual, rarer, and deliberately not overridden: a profile
 *   that sets one has asked its git to run that program.
 * - `CI=1` is deliberately NOT set here: pnpm's behaviour under `CI` differs
 *   (no prompts, a different reporter), and dsh's plugin manager already
 *   computes what it wants for its own children. This function adds only the
 *   variable that turns a hang into an error.
 *
 * An explicit `env` wins: a caller that narrowed the environment has said
 * what the child may see, and this only fills in what the spawn needs to
 * fail fast. Both variables are therefore overridden even when the caller
 * set them — a prompt cannot be answered on this path either way.
 */
export function installEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...(env ?? process.env),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  }
}

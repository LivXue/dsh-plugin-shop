<!-- Delete any line that does not apply. -->

**What this changes, and why.**

- [ ] `pnpm test` and `pnpm typecheck` pass
- [ ] The spec in `docs/design/` agrees with this change, or is amended in the same commit
- [ ] `registry/schema/plugin-entry.schema.json` not hand-edited (`pnpm emit:schema` regenerates it)
- [ ] User-facing docs changed in both languages (`X.md` and `X.zh.md`)
- [ ] The install pins in the four READMEs are untouched, unless this is a release commit

Coming from a fork? The catalog workflow runs without secrets: the harvest goes
unauthenticated, the classification step skips itself, and every write step is
gated off. That is expected, not a failure of your change.

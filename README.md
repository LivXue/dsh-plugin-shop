# dsh-plugin-store

The plugin store for [DeepSeek Harness](https://github.com/deepseek-harness) — discover, install, enable, and update dsh plugins from a browsable catalog.

DeepSeek Harness 的插件市场：从一份可浏览的 catalog 中发现、安装、启停和更新 dsh 插件。

## Status

Design complete, implementation not started. See [the design](docs/design/2026-08-18-dsh-plugin-store-design.md).

## What it is

- A **public community** market: publishing to npm with the `dsh-plugin` keyword is all it takes to be discovered. Nothing is submitted to this project.
- A **git-auditable** catalog: every daily change is a reviewable diff, not a row in someone's database.
- A **tiered trust** model: reviewed and unreviewed plugins are visually distinct, and a review is pinned to the exact version it covered.
- A **zero-privilege** browser UI: compromising the interface does not compromise the runtime.

## What it is not

**It is not a sandbox.** A dsh plugin, once mounted, holds the full `ctx` — your filesystem, your shell, and the requests going to the model. Installing one is complete trust. This project does not change that; it tells you the truth before you click.

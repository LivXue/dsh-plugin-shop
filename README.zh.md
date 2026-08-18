# dsh-plugin-store

[English](README.md) | 中文

DeepSeek Harness 的插件市场：从一份可浏览的 catalog 中发现、安装、启停和更新 dsh 插件。

## 状态

设计完成，尚未开始实现。见[设计文档](docs/design/2026-08-18-dsh-plugin-store-design.md)（英文）。

## Catalog

Catalog 每日构建，以静态 JSON 发布：

- `https://dsh-plugin-store.github.io/v1/index.json` —— 指针，携带 `schemaVersion`、`builtAt` 和内容哈希
- `https://dsh-plugin-store.github.io/v1/plugins.<sha256>.json` —— 数据

指针足够小，适合轮询；数据文件是内容寻址的，可以无限期缓存。每次构建的淘汰报告（每个被淘汰的包都附作者可读的原因）挂在对应的 workflow run 上。

## 它是什么

- 一个**公开社区**市场。带 `dsh-plugin` keyword 发布到 npm 即可被发现，无需向本项目提交任何东西。
- 一份 **git 内可审计**的 catalog。每日变化是一个可 review 的 diff，而不是某个数据库里的一行。
- 一套**分层信任**模型。已审核与未审核的插件在界面上可区分，且审核结论钉在它覆盖的那个版本上——作者通过审核后再发一个恶意版本，无法自动继承这份信任。
- 一个**零特权**的浏览器界面。UI 被攻破不等于运行时被攻破。

## 它不是什么

**它不是沙箱。** dsh 插件一旦 mount，就持有完整的 `ctx`——你的文件系统、你的 shell、以及发往模型的请求。安装即完全信任。本项目不改变这一点，只负责在你点击之前把话说清楚。

它也不提供下载量、评分和评论，并且永远不会有"从任意 URL 安装"按钮。那个能力保留在 `dsh plugin add` 里——在那里，开启构建脚本和钉住 commit 是你显式做出的决定。

## 让插件上架

在自己的 `package.json` 里加上 keyword 和 `dsh.catalog` 段，然后发布到 npm，每日构建会自动收录。

```json
{
  "name": "dsh-hello-plugin",
  "keywords": ["dsh-plugin"],
  "dsh": {
    "bundle":  { "patch": "./cordis.patch.yml" },
    "catalog": {
      "category": "tool",
      "summary": { "en": "...", "zh": "..." },
      "capabilities": ["fs", "shell"]
    }
  }
}
```

没有 `dsh.bundle` 的包是库而不是可安装插件，不予收录。没有 license 或没有仓库地址的包同样不予收录：没有仓库地址就无法审计。

## 许可

MIT

# Catalog schema

[English](schema.md) | 中文

插件通过在 `package.json` 里声明采集 keyword（`dsh-plugin` 或 `deepseek-harness`）来上架。从不发布 npm 的插件则按其 GitHub 仓库上架：给仓库加上 `dsh-plugin` 或 `deepseek-harness` topic，在仓库根放一个带 `name` 和 `dsh.bundle` 段的 `package.json`，目录就会把默认分支的 commit 钉为它的版本。下面的 `dsh.catalog` 段是**可选**的：声明它可以自主控制展示文案、分类和能力列表；不声明也照样上架，目录会从 npm 已有的信息里推导出一条列表。声明该段时对应的机读 schema 是 [`registry/schema/plugin-entry.schema.json`](../registry/schema/plugin-entry.schema.json)，由构建实际使用的校验器生成，因此不会与实际执行的规则脱节。

```json
{
  "keywords": ["dsh-plugin"],
  "dsh": {
    "bundle":  { "patch": "./cordis.patch.yml" },
    "catalog": {
      "category": "tool",
      "summary": { "en": "Does a thing", "zh": "做一件事" },
      "capabilities": ["fs", "shell"]
    }
  }
}
```

一旦声明 `dsh.catalog`，两种语言都必填——声明这一段本身就意味着两种都要写：

| 字段 | 必填 | 含义 |
|---|---|---|
| `category` | 是 | `tool`、`provider`、`ui`、`workflow`、`integration`、`theme`、`other` 之一 |
| `summary.en` | 是 | 一行，1–200 字符。不会被合成：缺了就是缺了 |
| `summary.zh` | 是 | 同上，中文 |
| `capabilities` | 是 | 至多 20 个自由字符串，说明插件用到的 dsh 服务 |

如果你不声明 `category`，商店可能通过自动评审为你分配一个分类；想自己掌控就声明它。`theme` 分类用于改变界面外观的插件：皮肤、主题、视觉样式。

如果你的仓库在 GitHub 上，star 数会自动显示——无需任何声明；其他托管平台的仓库不显示。

**`capabilities` 是作者自述，不被强制执行。** dsh 不对插件做沙箱隔离，因此该字段只是作者声称插件会碰什么。它只用于展示，不会被校验。**不要把它当成权限授予来读。**

未知字段会被拒绝而不是忽略，所以拼错字段名会让构建失败并指出是哪个字段，而不是悄悄丢掉你的数据。**校验失败的 `dsh.catalog` 段会被直接拒绝**，不会退回到推导上架——作者已经声明了这段内容却写错了，构建报告理应指出问题所在，而不是悄悄换一套数据顶上。

## 不写 `dsh.catalog` 时如何上架

完全省略这一段，包也照样能上架，展示文案来自你 npm `package.json` 自带的 `description` 字段：

| 字段 | 声明式 | 推导式（没有 `dsh.catalog`） |
|---|---|---|
| `metadata` | `declared` | `derived` |
| `summary.en` | 你写的文案 | 你的 npm `description`，去除首尾空白后截断到 200 字符 |
| `summary.zh` | 你写的文案 | 缺省 |
| `category` | 你的选择 | `other` |
| `capabilities` | 你的列表 | 空列表 |

如果既没有 `dsh.catalog`，npm 上也没有 `description`，这个包就不会被列出——没有任何文字可以展示。推导出的列表在发布数据里带 `metadata: "derived"`，消费端可以把它呈现为"尚未认领"；补上 `dsh.catalog` 就是认领它的方式。

`metadata` 和信任等级是两回事：一条推导式列表照样可以被标为 `verified`，因为审核看的是插件代码，不是文案。

## 发布的数据文件

每次构建都会把目录发布为一个内容寻址的数据文件 `plugins.<sha256>.json`，文件名由文件自身的哈希决定。除了已上架的 `plugins` 数组，它还带一个 `denied` 数组：每个被列入黑名单的包，以及作者可读的封禁原因。Host 在 `shop/installStart` 收到被列入黑名单的包的安装请求时，会查询这个 `denied` 列表来拦截。不属于封禁的拒绝——比如缺少 bundle、`dsh.catalog` 校验失败、包名与已有插件过于相似——只会出现在构建报告里，不会进入发布的数据文件。

每条列表都带 `added`，即它第一次出现在目录中的日期（YYYY-MM-DD）——由 registry 按包名记录，作者无需声明。因构建脚本（`requires-build`）而无法从 git 安装的 GitHub 条目，改为安装预构建的 release tarball：条目带一个可选的 `tarball` 对象（`url` + `sha256`），`version` 是 release 标签，`integrity` 是 tarball 的 sha256。这类条目的 `verified` 审核钉在 `reviewedSha256` 上——被审核 tarball 的内容哈希，而不是标签：标签是可变的引用，可以被删除后以不同内容重建，可信度必须钉在条目实际安装的东西上。`denied` 行可以带 `replacement`，即人工记录的合法替代包名。

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
| `capabilities` | 是 | 至多 20 个自由字符串，每项 1–64 字符，说明插件用到的 dsh 服务 |

如果你不声明 `category`，商店可能通过自动评审为你分配一个分类；想自己掌控就声明它。`theme` 分类用于改变界面外观的插件：皮肤、主题、视觉样式。

如果你的仓库在 GitHub 上，star 数会自动显示——无需任何声明；其他托管平台的仓库不显示。

**`capabilities` 是作者自述，不被强制执行。** dsh 不对插件做沙箱隔离，因此该字段只是作者声称插件会碰什么。它只用于展示，不会被校验。**不要把它当成权限授予来读。**

**凡是会进入发布目录的字段，长度都有上限。** 声明的内容会被原样写进每位读者都要下载的数据文件，所以超限的值会被指名拒绝，而不是照发：`summary.en` 与 `summary.zh` 各 200 字符，`capabilities` 每项 64 字符。构建替你读取的 npm 清单字段同样有上限——`name` 214 字符，`version` 128 字符，`dist.integrity` 256 字符，npm 给出的发布时间 64 字符，发布账号 128 字符，`license` 128 字符（再长就不可能是 SPDX 标识符），`repository` 512 字符；`peerDependencies` 最多记 128 个名字，每个不超过 128 字符。超出这两条的 peer 会从你的条目里丢掉，上架本身不受影响——这种裁剪是静默的，构建报告里没有它的行。从 GitHub 仓库上架的插件，根目录的 `package.json` 解码后不得超过 1 MB（1,048,576 字节）——这条上限量的是解码后 JSON 的字节数，构建读到上限就不再往下读；`name` 则要符合商店自己的 bundle 名文法，也就是 npm 的包名文法去掉小写那一条：可选的 `@scope/`，首字符必须是字母或数字，其余可用字母、数字、`.`、`-`、`_`，总长不超过 214 字符。这里允许大写——npm 发新包不允许，但仓库不是 npm 发布物，`DSH-FS-TOOL` 照样装得上；以 `.` 或 `_` 开头则不行，名字和 scope 都一样。子包的目录路径上限 200 字符，因为它会成为该条目自身的标识（`owner/repo#path`）：更长的不会上架，对应的行会注明路径已被截断。

**单条条目还有一个总体积预算，它和字段上限是两类不同的规则。** 字段上限说的是一个值可以长成什么样，预算说的是整条条目可以占多少。构建从你这里取走的全部内容——`dsh.catalog` 段、上面那些清单字段，以及裁剪后留下的 peers——会按它最终写进 `plugins.json` 的样子序列化，总量不得超过 **12,288 字节（12 KiB），按 UTF-8 字节计**，不是按字符：中文摘要在那里是一个字三字节。这条检查放在最后执行，npm 与 GitHub 两条上架通道都适用。它和 peers 的裁剪不同——它不缩短，而是直接拒绝：超预算的条目根本不会上架，Detail 会写明它实际占了多少字节、越过的是哪条预算。所以：整个包都不见了，去构建报告里找它那一行；条目在、只是少了几个 peer 名字，那是裁剪。两条规则在各自的极限上刻意无法同时满足——128 个各 128 字符的 peer 远远超过 12,288 字节，只会被拒——所以请把预算当成真正的天花板，把字段上限当成每个部分可以长成的形状。给个尺度：把 2026-09-04 观测到的各项最大值全塞进同一条条目，也只有 6,261 字节，今天上架的东西离预算还远。

构建报告把每条拒绝记成 **Reason** 和 **Detail** 两列——要看的是 Detail。有些 Reason 码比它实际承载的情况更宽：`license` 或 `repository` 超长记作 `no-license`、`no-repository`；而 `no-manifest` 涵盖了"我们确实读到了你的 `package.json`、但它无法上架"的每一种情形——因体积被拒、某个字段超长、整条超出条目预算，或者 `name` 不符合 bundle 名文法——所以明明声明了，Reason 却写着"没有"。准确的那一半在 Detail 里：它会说明你越过的是哪条上限。反过来这一点在你追查"为什么根本没上架"时很有用：`no-manifest` 意味着我们读到了你的 `package.json`，或者向它发起的请求得到了 404。如果是我们自己的请求失败了，那一行记的是 `fetch-failed`——它会在下一次构建时重试，不会算在你的仓库头上。

未知字段会被拒绝而不是忽略，所以拼错字段名会让构建失败并指出是哪个字段，而不是悄悄丢掉你的数据。这条提示信息本身也截断在 200 字符，被截断时结尾会带上 `… (truncated)`；字段名排在最前面，所以你真正要动手改的那部分一定还在。**校验失败的 `dsh.catalog` 段会被直接拒绝**，不会退回到推导上架——作者已经声明了这段内容却写错了，构建报告理应指出问题所在，而不是悄悄换一套数据顶上。

## 不写 `dsh.catalog` 时如何上架

完全省略这一段，包也照样能上架，展示文案来自你 npm `package.json` 自带的 `description` 字段：

| 字段 | 声明式 | 推导式（没有 `dsh.catalog`） |
|---|---|---|
| `metadata` | `declared` | `derived` |
| `summary.en` | 你写的文案 | 你的 npm `description`，去除首尾空白后截断到 200 字符 |
| `summary.zh` | 你写的文案 | 缺省 |
| `category` | 你的选择 | `other` |
| `capabilities` | 你的列表（至多 20 项，每项至多 64 字符） | 空列表 |

如果既没有 `dsh.catalog`，npm 上也没有 `description`，这个包就不会被列出——没有任何文字可以展示。推导出的列表在发布数据里带 `metadata: "derived"`，补上 `dsh.catalog` 就是认领它的方式。插件商店本身已经不再给推导条目加视觉标记，别的消费端要不要标成“尚未认领”由它们自己决定。

`metadata` 和信任等级是两回事：一条推导式列表照样可以被标为 `verified`，因为审核看的是插件代码，不是文案。

## 发布的数据文件

每次构建都会把目录发布为一个内容寻址的数据文件 `plugins.<sha256>.json`，文件名由文件自身的哈希决定。除了已上架的 `plugins` 数组，它还带一个 `denied` 数组：每个被列入黑名单的包，以及作者可读的封禁原因。Host 在 `shop/installStart` 收到被列入黑名单的包的安装请求时，会查询这个 `denied` 列表来拦截。不属于封禁的拒绝——比如缺少 bundle、`dsh.catalog` 校验失败、包名与已有插件过于相似——只会出现在构建报告里，不会进入发布的数据文件。

每条列表都带 `added`，即它第一次出现在目录中的日期（YYYY-MM-DD）——由 registry 按包名记录，作者无需声明。因构建脚本（`requires-build`）而无法从 git 安装的 GitHub 条目，改为安装预构建的 release tarball：条目带一个可选的 `tarball` 对象（`url` + `sha256`），`version` 是 release 标签，`integrity` 是 tarball 的 sha256。这类条目的 `verified` 审核钉在 `reviewedSha256` 上——被审核 tarball 的内容哈希，而不是标签：标签是可变的引用，可以被删除后以不同内容重建，可信度必须钉在条目实际安装的东西上。`denied` 行可以带 `replacement`，即人工记录的合法替代包名。

npm 条目还带一个 `peers` 字段——插件在 `peerDependencies` 里声明的模块名，从不包含版本范围。读者自己的 dsh 会拿这些名字逐一匹配本机的安装，把解析不到的报告回来，商店据此在有人安装一个自己 harness 跑不起来的插件之前，先打上标记。

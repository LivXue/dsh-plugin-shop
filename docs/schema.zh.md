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

**凡是会进入发布目录的字段，长度都有上限。** 声明的内容会被原样写进每位读者都要下载的数据文件，所以超限的值会被指名拒绝，而不是照发：`summary.en` 与 `summary.zh` 各 200 字符，`capabilities` 每项 64 字符。构建替你读取的 npm 清单字段同样有上限——`name` 214 字符，`version` 128 字符，`dist.integrity` 256 字符，npm 给出的发布时间 64 字符，发布账号 128 字符，`license` 128 字符（再长就不可能是 SPDX 标识符），`repository` 512 字符；无论从哪条通道上架，`peerDependencies` 都只记必需的 peer，最多 128 个名字，每个不超过 128 字符，标为可选的 peer 在计数前就已剔除，不占名额。超出这两条的 peer 会从你的条目里丢掉，上架本身不受影响——这种裁剪是静默的，构建报告里没有它的行。`dsh.compatibility` 同样有上限：`dsh` 范围 256 字符，每个 profile 名 64 字符，最多 16 个 profile；超限的部分同样静默丢弃，报告里同样没有它的行。`dist.unpackedSize`——npm 包在货架上显示的那个体积的来源——同样是替你读的，只有当 npm 给出的是安全范围内的非负整数时才会保留；其余一律丢弃，你的条目照常上架、只是没有体积，这同样是静默的，报告里同样没有行。0 会保留而不是丢弃：npm 对空 tarball 就是报 0，货架照实显示「0 B」。从 GitHub 仓库上架的插件，根目录的 `package.json` 解码后不得超过 1 MB（1,048,576 字节）——这条上限量的是解码后 JSON 的字节数，构建读到上限就不再往下读；`name` 则要符合商店自己的 bundle 名文法，也就是 npm 的包名文法去掉小写那一条：可选的 `@scope/`，首字符必须是字母或数字，其余可用字母、数字、`.`、`-`、`_`，总长不超过 214 字符。这里允许大写——npm 发新包不允许，但仓库不是 npm 发布物，`DSH-FS-TOOL` 照样装得上；以 `.` 或 `_` 开头则不行，名字和 scope 都一样。子包的目录路径上限 200 字符，因为它会成为该条目自身的标识（`owner/repo#path`）：更长的不会上架，对应的行会注明路径已被截断。

**卡片上的体积是实测出来的，怎么测取决于你从哪条通道上架。** 货架显示的是"装上它会往磁盘里放多少"，进入发布目录后叫 `installSize`——你直接读 `plugins.json` 时要找的就是这个键。npm 包用的是 npm 自己的 `dist.unpackedSize`，所以卡片和你的 npm 页面对得上。从 GitHub 仓库上架的，则是所钉住的那个 commit 下 git tree 里各文件大小之和；你的条目若指向子包目录，就只算那个目录，所以 monorepo 不会被整仓算账。目录和子模块不计入：子模块的内容不在这棵 tree 里，tarball 安装也不会去取它。它**不是** GitHub 给出的仓库体积——那个数含历史记录，并不是你装下来的东西。

仓库口径通常比同一份代码的 npm 口径大，这是真实内容而非误差：仓库里还有测试、文档和截图，它们被你 npm 的 `files` 白名单挡在外面，而按仓库安装确实会把这些一并放到磁盘上。

体积只是装饰，测不出来只会少一个标签，绝不会影响上架，而且下面这些情况在构建报告里都没有行。你的体积会缺席，如果：npm 没给 `dist.unpackedSize`（比 npm 5.6 更早的发布），或给出的不是安全范围内的非负整数；或者在 GitHub 这条通道上，tree 返回时被截断、其中某个元素读不出来、某个文件报了负数或超出安全整数范围的大小、累加和越过 2^53，又或者根本没有任何文件被计入——空 tree，或者子包目录没匹配到东西。最后这条是刻意的：数到零个文件和"总共零字节"不是同一个说法，publish 一个「0 B」等于宣称装上你的插件不占地方。

**单条条目还有一个总体积预算，它和字段上限是两类不同的规则。** 字段上限说的是一个值可以长成什么样，预算说的是整条条目可以占多少。构建从你这里取走的全部内容——`dsh.catalog` 段、上面那些清单字段、裁剪后留下的 peers、`dsh.compatibility` 声明，以及 npm 给出了体积时的那个数字——会按它最终写进 `plugins.json` 的样子序列化，总量不得超过 **12,288 字节（12 KiB），按 UTF-8 字节计**，不是按字符：中文摘要在那里是一个字三字节。这条检查放在最后执行，npm 与 GitHub 两条上架通道都适用。它和 peers 的裁剪不同——它不缩短，而是直接拒绝：超预算的条目根本不会上架，Detail 会写明它实际占了多少字节、越过的是哪条预算。所以：整个包都不见了，去构建报告里找它那一行；条目在、只是少了几个 peer 名字，那是裁剪，或者那几个 peer 被你标成了可选。两条规则在各自的极限上刻意无法同时满足——128 个各 128 字符的 peer 远远超过 12,288 字节，只会被拒——所以请把预算当成真正的天花板，把字段上限当成每个部分可以长成的形状。给个尺度：把 2026-09-04 观测到的各项最大值全塞进同一条条目，也只有 6,294 字节，今天上架的东西离预算还远。

构建报告把每条拒绝记成 **Reason** 和 **Detail** 两列——要看的是 Detail。有些 Reason 码比它实际承载的情况更宽：`license` 或 `repository` 超长记作 `no-license`、`no-repository`；而 `no-manifest` 涵盖了"我们确实读到了你的 `package.json`、但它无法上架"的每一种情形——因体积被拒、某个字段超长、整条超出条目预算，或者 `name` 不符合 bundle 名文法——所以明明声明了，Reason 却写着"没有"。准确的那一半在 Detail 里：它会说明你越过的是哪条上限。反过来这一点在你追查"为什么根本没上架"时很有用：`no-manifest` 意味着我们读到了你的 `package.json`，或者向它发起的请求得到了 404。如果是我们自己的请求失败了，那一行记的是 `fetch-failed`——它会在下一次构建时重试，不会算在你的仓库头上。

**已上架的包离开目录时，报告会写明原因。** 每次构建都会把本次收录和上次发布的目录对比。如果你的 npm 包上次在目录里、这次没被收录，构建会向 npm 查询一次。最新版仍带 `dsh-plugin` 或 `deepseek-harness` 关键词且没有弃用的包，会继续上架；否则，那次构建的报告会写一行：`deprecated` 并引用你的弃用说明（最多 200 个字符），或者 `npm-gone`，说明它是被撤销发布、已不在 registry 上（npm 返回 404）、去掉了两个关键词，还是去询问时 npm 根本没回答——最后那种情形会写明失败原因，它只代表这一次构建查到的情况，不是对你的包下的结论。把关键词加回去，下次构建就会重新上架。（见设计文档 2026-09-26-market-borrowings §8.2。）

**从 GitHub 仓库收录的条目，装的就是固定 commit 的原样内容。** 从 git 安装不会运行任何构建，所以 bundle 要加载的每个文件都必须在那个 commit 里：每个 `dsh.bundle.patch` 文件，以及 patch 插入的你自己包里的每个模块经 `exports`（或 `main`）解析到的文件。被 `.gitignore` 排除的 `lib/` 或 `dist/` 不在仓库里，这样的条目会以 `requires-build` 被拒绝，并写明缺的是哪个文件。可以把构建产物提交进仓库、把包发布到 npm，或者（仅限仓库根）在最新的 release 里附上打包好的 tarball（在构建好的目录里运行 `npm pack`）。monorepo 的子包无法靠 release 补救。（见设计文档 2026-09-26-market-borrowings §9.3 和 §9.6。）

**会破坏快照锁行的 version 或 integrity 会被拒绝。** 每日快照给每个上架的包在 `manifest.lock` 里写一行，后续构建会读回这个文件，所以带空白或控制字符的 `version`，或者不符合 SRI 哈希文法（`algorithm-base64`、空格分隔）的 `dist.integrity`，都会让它那一行无法解析。这样的包会被拒绝，Detail 会写明是二者中的哪一个；用普通的版本号、保留 npm 自己签发的 integrity 发布即可。（这是上面规则里 `no-manifest` / `no-integrity` 的文法情形。）

**同样的文法约束 GitHub 条目的身份标识。** GitHub 条目的 `owner/slug`、bundle 名、固定的 commit 或 tag 会逐字节写进提交的产物——`manifest.lock` 的 github 行、构建报告——而且没有长度上限，所以其中任何一个带空白或控制字符都会被拒绝。用纯文本的名字和 tag 发布即可。（与 npm 行的 SRI 规则是同一道防线。）（Reason 记作 `no-manifest`。）

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

## 已上架，却装不上或加载不了

上架只说明构建读过你的 manifest，没有发现会被拒绝的地方。构建从不安装、也从不运行你的插件，所以已上架的插件仍可能在读者的机器上失败。下面按情况写出 dsh 0.2.0-rc.2（2026-10-13 时 `@deepseek-ai/dsh` 在 npm 上的 `latest`）会怎么做——依据是它的源码——以及你能改什么。

**harness peer 的范围没有覆盖读者的 dsh。** dsh 会把 `peerDependencies` 里每一个名为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的条目（标了 optional 的也算）与它正在运行的版本比对；范围不含当前版本时，安装会被拒绝：dsh 能从 registry 读到你的 manifest 时，在 pnpm 运行之前就拒绝；否则在 pnpm 之后拒绝，并恢复 profile 的 `package.json` 和 lockfile。读者升级 dsh 之前就装好的插件仍留在 profile 里，但启动时会被跳过。读者可以用 `dsh plugin allow-version` 为某一个确切版本接受风险；商店何时在点击之前就做这项检查并给出这条命令，见下文 `dshPeers` 一段。预发布版本的算法与下文 `dsh.compatibility` 一段相同，而 `0.x` 版本上的 caret 范围止于下一个次版本：`^0.1.0-rc.6` 不接受 `0.2.0-0` 及以后的任何版本，所以会拒绝 dsh 0.2.0-rc.2。和 `dsh.compatibility` 不同，dsh 解析不了的范围会被拒绝，而不是不予判断。只有 `workspace:^`、`workspace:~`、`workspace:*` 这三种写法按正在运行的版本算，所以 `npm publish` 原样发布出去的 `workspace:^0.1.0` 会被任何版本的 dsh 拒绝。请声明你实际运行过的 dsh 版本范围，并用会改写 `workspace:` 范围的 `pnpm publish` 发布。

**patch 插入的包也按同样的规则检查。** pnpm 之后，dsh 还会读取你的 `dsh.bundle.patch` 插入的每一个包，检查它的 harness peer；其中任何一个被拒绝，整次安装都会被拒绝。商店在点击之前只判断你自己的 manifest，所以这类拒绝要到 pnpm 运行之后才会出现。请只插入 harness peer 覆盖你所声明 dsh 版本的包。

**`dsh.bundle.patch` 必须是一个文件路径或一组文件路径，而且列出的每个文件都要在安装下来的内容里。** 没有 `patch`、写成其他值（`true`、数字、对象、含非字符串的列表），或者列出的文件不存在，dsh 都读不了你的包：安装时以 `Cannot validate installed package` 拒绝，任何豁免都清除不了；已经装好的包则在启动时被跳过，并打印一行 `skipping profile bundle` 写明原因。

**目录从不打开 npm 的 tarball。** npm 包只凭 registry 的元数据上架，所以发布时漏掉的文件只有读者安装时才会暴露：缺少 patch 文件会像上一条那样被拒绝；patch 插入的模块不在包里，则在 dsh 启动它时失败。发布前运行 `npm pack --dry-run`，确认它列出的文件里有 `dsh.bundle.patch` 列出的每个文件，以及 patch 插入的每个模块经 `exports`（或 `main`）解析到的文件。GitHub 上架的条目已经在上架时按这一点检查（见上文的 `requires-build`）。

**激活时出错记在你的条目名下；没有处理的错误会让 dsh 退出。** dsh 激活你的条目时，它抛出的错误或拒绝的 promise 都记在这个条目名下：dsh 照常启动 profile 里的其余部分（等你所提供服务的插件除外），并打印 `warning: N entries did not activate`，写出你的条目 id、包名和错误。除此之外，任何时刻出现的未处理的 promise 拒绝或未捕获的异常——无论在启动期间还是启动很久以后，比如回调里抛出的错误、没有监听者的 `error` 事件、没有任何地方处理的被拒绝的 promise——都会结束整个进程：dsh 打印 `dsh: fatal load failure` 或 `dsh: fatal uncaught exception` 和错误内容，并以状态码 1 退出。另外，dsh 必需的条目没有激活时，它会启动失败并打印 `startup failed: N required plugins did not activate`——必需条目是一组固定的内置 id，例如 `connection` 和 `webserver`——而必需条目一直在等某个服务也算在内：`connection` 要等 `credentials` 服务，所以凭据提供方失败会让 dsh 起不来；提供了某个必需条目所等服务的插件失败时也一样。激活返回之后，你的代码可能引发的每一个错误都要自己处理。

**在 pnpm 11 下，需要构建脚本的安装会失败。** dsh 用读者手上的那个 pnpm 安装。pnpm 11 除非 profile 允许，不运行任何包的构建脚本；默认（`strictDepBuilds`）还会让被拦下的脚本中止安装，报 `ERR_PNPM_IGNORED_BUILDS` 并写出包名，dsh 把它归为 `build-blocked`。这既包括你自己的 `preinstall`、`install`、`postinstall`，也包括每个依赖的。读者得先允许这些脚本——pnpm 的提示指向在 profile 目录里运行的 `pnpm approve-builds`——再重新安装。请发布构建好的代码，不要在安装时构建。

**目录列出的版本在下一次构建之前都要能装。** 目录每天重读一次你的包，商店安装的正是目录列出的那个版本，所以撤下（unpublish）这个版本后，商店会向 npm 要一个它已经没有的版本。请改为弃用（deprecate）它，或者发布修好的新版本。

**一个 profile 里每个名字只能有一个包。** profile 每个名字只记一个依赖，所以沿用原包 `name` 的 fork 永远不能和原包装在一起：`dsh plugin add` 会替换掉两者中已装的那个；商店则拒绝安装，指出占着这个名字的包，直到读者把它卸载。fork 请换一个自己的 `name`。

**按读者的方式试装你的插件。** 在一个临时的 dsh home 里，用商店使用的规格添加插件，再启动 dsh，看它打印了什么：

```sh
export DSH_HOME="$(mktemp -d)"
dsh plugin --profile web add <spec>
dsh --profile web --no-open --port 0
```

然后打开它打印的地址。`--port 0` 会取一个空闲端口：用默认端口的话，你已经在运行的 dsh 会让这一个起不来，因为 `webserver` 是必需条目。`<spec>` 对 npm 包是 `name@version`，对 GitHub 上架的条目是 `github:owner/repo#<commit>`（子包再在后面加 `&path:<dir>`），对从 release tarball 安装的条目是那个 release 资源的 URL。在你声明支持的每个 dsh 版本上各试一次，再在 `@deepseek-ai/dsh` 在 npm 上的 `latest` 上试一次。

## 发布的数据文件

每次构建都会把目录发布为一个内容寻址的数据文件 `plugins.<sha256>.json`，文件名由文件自身的哈希决定。除了已上架的 `plugins` 数组，它还带一个 `denied` 数组：每个被列入黑名单的包，以及作者可读的封禁原因。Host 在 `shop/installStart` 收到被列入黑名单的包的安装请求时，会查询这个 `denied` 列表来拦截。不属于封禁的拒绝——比如缺少 bundle、`dsh.catalog` 校验失败、包名与已有插件过于相似——只会出现在构建报告里，不会进入发布的数据文件。

每条列表都带 `added`，即它第一次出现在目录中的日期（YYYY-MM-DD）——由 registry 按包名记录，作者无需声明。因构建脚本（`requires-build`）而无法从 git 安装的 GitHub 条目，改为安装预构建的 release tarball：条目带一个可选的 `tarball` 对象（`url` + `sha256`），`version` 是 release 标签，`integrity` 是 tarball 的 sha256。这类条目的 `verified` 审核钉在 `reviewedSha256` 上——被审核 tarball 的内容哈希，而不是标签：标签是可变的引用，可以被删除后以不同内容重建，可信度必须钉在条目实际安装的东西上。`denied` 行可以带 `replacement`，即人工记录的合法替代包名。

每条条目——无论来自 npm 还是 GitHub——还带一个 `peers` 字段：插件在 `peerDependencies` 里声明的**必需** peer 的名字，从不包含版本范围；一个必需 peer 都没有时不带这个字段。在 `peerDependenciesMeta` 里标了 `optional: true` 的 peer 不会被记录，因此永远不会引出提示。从 GitHub 仓库上架的条目，其 peers 现在就会被读取，但要等能按下文方式判断它们的商店版本成为当前版本后才会发布——旧版商店会误判它们；之后每个仓库在下次被重新读取时补上这个字段——每个仓库只补读一次，分摊在之后若干天的每日构建里。读者自己的 dsh 会拿每个名字既去匹配本机的安装，也去查它网页端自己提供的模块，只有两边都提供不了的名字才会提示，商店据此在有人安装一个自己 harness 跑不起来的插件之前，先打上标记。0.8.3 及更早的商店只查本机安装，因此可能对网页端自己就提供的模块（比如 `react`）给出提示；读者更新商店后，这类提示就会消失。这项必需 peer 的检查只是提示，从不拒绝：卡片上照样可以安装。

条目还带 `dshPeers`：你对 harness 本身的 peer，即 `@deepseek-ai/dsh` 和所有 `@deepseek-ai/dsh-*`，各自带着你写的版本范围，可选的也包括在内，因为 dsh 会全部读取。GitHub 条目会同时带上 `manifestVersion`，即实际安装的 `package.json` 里的 `version`：dsh 按这个版本记录豁免，而不是按目录钉住的 commit 或 tag；manifest 里没有可用版本的条目两者都不带。每个仓库会在下次被重新读取时补上这两个字段，分摊在之后若干天的每日构建里。从 dsh 0.1.7 起，如果运行中的版本不满足这些 harness peer，dsh 自己就会拒绝安装，除非读者为这个确切版本授予了豁免。从 dsh 0.1.7 起，比 0.8.3 更新的商店会在点击之前对 npm 条目做同一项检查，0.8.7 起的商店还会按 `manifestVersion` 对 GitHub 条目做这项检查：0.8.4 到 0.8.6 的商店禁用“安装”按钮，0.8.7 起改为在按钮的位置显示红色标签。两种情况下，卡片都会给出 dsh 自己的豁免命令，读者若愿意承担风险即可运行。

如果你的 manifest 声明了 `dsh.compatibility`，目录也会把它记下来：`dsh` 是一个 semver 范围，写明你支持的 dsh 版本；`profiles` 是你支持的 dsh profile 模板，也就是 dsh 自带的那些名字，0.1.5 上是 `web`、`acp`、`headless`、`sdk` 和 `sdk-minimal`。两者都可选，也可以只写其中一个；其中一半格式不对，只丢掉那一半，不连累另一半。构建只负责抄录，不做判断——由读者自己的 dsh 拿它和自己实际运行的版本与 profile 比对，有一项对不上，商店就给出提示，并写明两边：你声明的是什么，读者实际运行的又是什么。从 release tarball 安装的 GitHub 条目，拿来比对的是那个 tarball 里的 `package.json`，而不是你默认分支上的那一份；它的 `peers` 也从同一个文件里读。你写的 profile 有两种满足方式：读者的 profile 正好叫这个名字，或者它是用这个模板的 bundle 搭起来的，不管叫什么——所以名叫 `web` 的 profile 满足 `web`，用 web 那组 bundle 搭起来的其他 profile 也满足。你写的名字如果不在读者那版 dsh 自带的模板之列，就只有名字完全相同的 profile 才算满足，其余情况无从判断；列表里只要有一个这样的名字，profile 这一项就永远不会给出提示。预发布版本同样算数，`>=0.1.0` 也接受 `0.1.5-rc.3`；但范围完全按 semver 的规则来读，而预发布版本比它对应的正式版低。所以下限会把自己那一版的预发布版本挡在外面：`>=0.1.5` 和 `^0.1.5` 都不接受 `0.1.5-rc.3`，想把所有 `0.1.5-rc.N` 都算进来，要写 `>=0.1.5-0` 或 `^0.1.5-0`。手写的上限正好相反，会把下一条版本线的预发布版本放进来：`<0.2.0` 接受 `0.2.0-rc.1`，想在它们之前止步，就写 `<0.2.0-0`——`^0.1.0` 和 `~0.1.0` 本来就是这样划的。dsh 解析不了的范围不做判断，也不去猜。这只是提示，从不拒绝安装；什么都不声明也不等于声明不兼容，不会产生任何提示。

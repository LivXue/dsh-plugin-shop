# 参与贡献

[English](CONTRIBUTING.md) | 中文

来这里的人想做的是三件不同的事，彼此除了这一页之外没有交集。挑你那一条看。

| 我想 | 看 |
|---|---|
| 纠正一个分类器判错的上架决定 | [1. 纠正一次判决](#1-纠正一次判决) |
| 让自己的插件进目录 | [2. 让插件上架](#2-让插件上架) |
| 改流水线本身 | [3. 改流水线](#3-改流水线) |

## 1. 纠正一次判决

这里最便宜的一次贡献是改一行 YAML。不需要写 TypeScript，不需要联网，也不需要
在本地跑构建。

本项目的审核是自动的。分类器决定的是**呈现**——一个条目归到哪个类目下，以及货架
要不要为一个看起来像竞品市场的名字打广告。它从不决定目录里**有什么**，那是 gate
的职责，且每一条规则都由 fixture 驱动。所以判错只会改变浏览者看到的样子，不会改变
目录持有的内容；纠正它，就是去改记下这次判决的那一行。

每次构建都会公开它自己单独做的决定：

> <https://LivXue.github.io/dsh-plugin-shop/v1/report.md>

报告开头列出了所有仅凭分类器判决、无人复核就被拦在货架之外的条目。那份名单就是
待办清单。

判决存在三个文件里：

| 文件 | 决定什么 |
|---|---|
| `registry/categories.yml` | 作者没声明类目时，条目归到哪一类 |
| `registry/markets.yml` | 一个像商店的名字是不是真的竞品 dsh 插件市场 |
| `registry/denied.yml` | 永久排除，条目里必须写明理由 |

找到那一行改掉。`categories.yml` 有一万九千多行——用 `grep -n`，别在编辑器里滚：

```sh
grep -n 'dsh-your-plugin' registry/categories.yml
pnpm test          # 全程离线；这条通道不需要收割
```

**已记录的判决不会被重新询问。** 这正是这次改动值得做的原因：构建不会回头重看一条
已经存在的记录，所以你写下的那一行从此就是答案。这也意味着改错了同样是永久的——在
PR 里说清楚你实际核对了什么。

一个例外：如果某个插件是恶意的，**不要**公开提一个把它加进 `denied.yml` 的 PR。
请私下上报，理由见 [SECURITY.md](SECURITY.zh.md)。

## 2. 让插件上架

上架不需要你向本仓库提交任何东西。目录按关键字收割：在 `package.json` 的 keywords
里加上 `dsh-plugin` 或 `deepseek-harness` 并发布到 npm，第二天的构建就会收进来。
从不发 npm 的插件则从它的 GitHub 仓库上架——同样的关键字加成仓库 *topic*，再在根目录
留一个带 `name` 和 `dsh.bundle` 的 `package.json`。字段全表见
[docs/schema.zh.md](docs/schema.zh.md)。

**发了，但货架上没有？** 先自己查，别急着问。每一条拒绝都是公开的，带一个原因码和
一句写给作者看的说明：

```sh
curl -s https://LivXue.github.io/dsh-plugin-shop/v1/report.md | grep '| 你的包名 |'
```

要看 **Detail** 那一列，而不是 Reason。原因码数量很少，且明知比字面意思宽：
`no-manifest` 是「我们确实读到了 manifest，但它无法上架」的所有情况的统一代号——
体积超限被拒、读不出来、名字不符合 bundle 名文法、某个字段越界——所以它可能对着一个
你确确实实写了的 `package.json` 说「没有 manifest」。准确的那一半在 detail 里，它会
说清楚越的是哪条界。

当 detail 对你的包的描述是错的，或者你的名字在目录和拒绝表里都找不到时，开一个
*Plugin not listed* issue。

## 3. 改流水线

先读两份文件。[`docs/design/`](docs/design/) 是规格，并且是权威：代码、测试和文字都
跟着它走；三者与它冲突时，要么规格胜出，要么在同一次改动里把规格一起改掉——改规格是
正常操作。`CLAUDE.md` 是工作约定，记着那些不变量、惯例，以及它们背后的实测数据。

然后是四件不先知道就会浪费你一个下午的事。

**纯核心，脏外壳。** `CLAUDE.md` 点名为纯的那些模块——`gate.ts`、`tier.ts`、
`emit.ts`、`pipeline.ts` 及其同类——不碰时钟、不碰网络、不碰文件系统、不碰环境变量，
也不碰 locale。所有策略决策都住在那里，这正是 fixture 能驱动全部逻辑的原因。一个迁进
外壳的决策就变得不可测试。纯模块需要时间，就把时间当参数传进去。

**测试全程不联网。** `pnpm test` 离线覆盖每一条策略决策。`pnpm build:catalog` 是真实
收割——数千次对 npm 和 GitHub 的实时请求，跑好几分钟。**不要**用它来验证改动能不能
编译。改了抓取层或写入层、需要端到端看一遍时才跑它。

**`registry/schema/plugin-entry.schema.json` 是生成物。** zod schema 是 catalog 段的
唯一定义；用 `pnpm emit:schema` 重新生成，永远不要手改那个 JSON。有一个新鲜度测试守着它。

**来自 fork 的 PR 拿不到 secrets，这是刻意的。** GitHub 不会把仓库 secrets 交给来自
fork 的 `pull_request` 事件，所以你的 run 没有 LLM key，也没有 stars token。目录工作流
就是照这个前提写的：收割改走匿名，分类那一步自己跳过。你的 run 里分类被跳过是设计，
不是你弄坏了什么。同时所有写入步骤都被关掉，所以一个 PR run 是一次完整的空转，什么都
不会发布。

两条惯例，趁 review 意见还没找上门先说。面向用户的文档是双语成对的（`X.md` 与
`X.zh.md`，双向互链，中文用自己的语域陈述同样的事实，而不是逐字翻译）；而设计文档和
规格只用英文。还有，你写下的每一句 rejection `detail` 都会被发布给一个正想弄清楚自己的
包为什么没上架的插件作者——写错或张冠李戴是缺陷，不是措辞小事。

## 其余

- 好好说话：[行为准则](CODE_OF_CONDUCT.zh.md)，联系方式
  <xuedizhan17@mails.ucas.ac.cn>。
- 漏洞和恶意插件走[私下渠道](SECURITY.zh.md)，永远不要开公开 issue。
- 贡献同样以 [Apache-2.0](LICENSE) 授权，与项目其余部分一致。

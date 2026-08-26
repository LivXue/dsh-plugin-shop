<div align="center">

# dsh-plugin-shop

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件商店** —— 在设置页的一个标签里
浏览 dsh 插件目录、一次确认完成安装、管理已装插件。

[![npm](https://img.shields.io/npm/v/dsh-plugin-shop?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-shop)
[![license](https://img.shields.io/npm/l/dsh-plugin-shop?color=blue)](https://github.com/LivXue/dsh-plugin-shop/blob/main/LICENSE)
[![plugin CI](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/plugin.yml/badge.svg)](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/plugin.yml)
[![catalog](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/daily.yml/badge.svg)](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/daily.yml)

[English](https://github.com/LivXue/dsh-plugin-shop/blob/main/packages/dsh-plugin-shop/README.md) | 中文

</div>

---

## 🖼️ 界面预览

<div align="center">
<img src="https://raw.githubusercontent.com/LivXue/dsh-plugin-shop/main/docs/images/shelf-light.png" alt="dsh 设置页里的插件商店货架" width="860">
</div>

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/LivXue/dsh-plugin-shop/main/docs/images/gate-light.png" alt="安装未评审插件需要显式确认"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/LivXue/dsh-plugin-shop/main/docs/images/shelf-dark.png" alt="深色主题下的同一片货架"></td>
</tr>
<tr>
<td align="center"><sub>安装未评审插件需要显式确认</sub></td>
<td align="center"><sub>深色主题下的同一片货架</sub></td>
</tr>
</table>

## 📦 安装

下面两条路做的是同一件事，按读者是谁挑一条。

### 🧑 给人看

**前置条件：** Node.js，以及 `dsh` CLI 本身——先执行一次
`npm install -g @deepseek-ai/dsh` 安装，再用 `dsh --version` 验证。商店的安装
指令假设 `dsh` 已在你的 PATH 上。

```sh
dsh plugin --profile web add dsh-plugin-shop
```

如果你用的不是 `web` profile，把它换成你自己的。然后重启一次 `dsh`——新加的 bundle 不会作用于
已在运行的进程——再打开

> **设置 → 插件 → 插件商店**

进去是一片插件卡片货架，带搜索框。首次加载要联网读目录，可能要等几秒，期间由一层扫光骨架占位。

### 🤖 给 agent 看

全程非交互，无提示、无需确认。`--profile` 是**必填**的——不给它，`dsh plugin` 会以
`error: required option '--profile <name>' not specified` 退出。

**1. 确定 profile 名。** profile 是 `$DSH_HOME/profiles` 下的目录（`$DSH_HOME` 默认
`~/.dsh`）。那里还会出现 `node_modules`，它**不是** profile。

```sh
ls -1 "${DSH_HOME:-$HOME/.dsh}/profiles" | grep -v '^node_modules$'
```

**2. 安装。**

```sh
dsh plugin --profile <profile> add dsh-plugin-shop
```

**3. 验证——这步别省。** 第 2 步返回 0 只说明 pnpm 解析到了这个包，不代表 profile 会加载它。
要断言的是 bundle 列表：

```sh
dsh plugin --profile <profile> list --depth 0
```

`dsh-plugin-shop` 必须出现并带有已解析的版本号。想直接读清单也行，同一事实位于
`$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles`。

**4. 重启该 profile**——`dsh --profile <profile>`，web profile 用 `dsh web`。启停**已安装**的
插件是热生效的；新增 bundle 不是。

#### 失败模式

| 你看到什么 | 含义 | 怎么办 |
|---|---|---|
| `error: required option '--profile <name>' not specified` | 漏了 `--profile` | 补上，它没有默认值 |
| 装到的版本比 npm 的 `latest` 旧 | pnpm 11 会压住刚发布不久的版本 | 属预期而非错误，冷却期过后自然拿到最新 |
| `client bundles not found ... lib/client.js` | 磁盘上那份没有构建浏览器半边 | 从 npm 安装而不是从源码 checkout，或在该 checkout 里跑 `pnpm build` |
| `no profile directory found above <path>` | 插件定位不到自己的 profile | 请报告——这是由 `ctx.baseUrl` 解析的，不该失败 |
| 重启后标签没出现 | bundle 不在 profile 的 `bundles` 里 | 重跑第 3 步；若确实不在，说明第 2 步没走完 |

## ✨ 能做什么

| | |
|---|---|
| **浏览与搜索** | 按 `dsh-plugin` 关键字从 npm 采集的 1800+ 个包；作者若自己声明了简介就用作者原话 |
| **安装** | 一次确认。未经评审的插件需先显式确认——装上之后它与内置插件权限等同 |
| **启停** | 对已安装插件生效，无需重启 |
| **过期提示** | 与目录中的当前版本比对 |

## 🧩 结构

一个包里装了两半，两者之间的分界就是安全边界：

| 半边 | 入口 | 能触及 | 不能触及 |
|---|---|---|---|
| **Host** | `dsh-plugin-shop` | 网络（取目录并校验 sha256）、文件系统（缓存）、per-profile 互斥锁下的 `dsh plugin add` | —— |
| **Client** | `dsh-plugin-shop/client` | 仅五个 `shop/*` Remote 方法 | 网络、文件系统 |

攻破浏览器那一半，攻击者拿到的就是那五个调用，别无其他。

## ⚙️ 配置

| 变量 | 作用 |
|---|---|
| `DSH_SHOP_CATALOG_URL` | 把目录源指向你自己的镜像，替代公共源 |

## 📚 目录

每日从公共 npm registry 构建，以静态 JSON 发布：

- [`/v1/index.json`](https://LivXue.github.io/dsh-plugin-shop/v1/index.json) —— 指针，携带 `schemaVersion`、`builtAt` 和内容哈希
- `/v1/plugins.<sha256>.json` —— 数据，内容寻址，可无限期缓存

指针足够小，适合轮询。在信任数据文件的任何一个字节之前，商店会先用指针里的 sha256 校验它。

## ⚠️ 不作何承诺

出现在货架上不等于背书。

`capabilities` 只是作者对自己包的自述。**v0 没有沙箱**，界面也从不把这个字段渲染成一份被强制
执行的权限清单。`verified` 层的含义是有人读过**那个确切版本**；一旦发布新版本就降级为
`verified-stale`，评审记录仍钉在它当初对应的版本上——所以过一次评审，买不到后续每个版本的信任。

## 🏷️ 面向插件作者

在 `package.json` 里加上 `"keywords": ["dsh-plugin"]` 然后发布，每日构建就会找到你，不需要向本
项目提交任何东西。声明 `dsh.catalog` 段可以自己掌控分类、简介和 capabilities；不声明，目录会从
你的 npm `description` 推导一条 listing。

完整参考：[docs/schema.zh.md](https://github.com/LivXue/dsh-plugin-shop/blob/main/docs/schema.zh.md)。

## 📄 许可

[MIT](https://github.com/LivXue/dsh-plugin-shop/blob/main/LICENSE) © LivXue

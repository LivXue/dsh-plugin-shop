# dsh-plugin-shop

[English](https://github.com/LivXue/dsh-plugin-shop/blob/main/packages/dsh-plugin-shop/README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-harness) 的插件市场，以设置页里的一个
标签呈现：浏览 dsh 插件目录、一次确认完成安装、启停已安装的插件、看到哪些有了新版本。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-plugin-shop
```

重启一次 `dsh`，标签出现在 **设置 → 插件 → 插件市场**。

## 能做什么

- **浏览与搜索**目录——按 `dsh-plugin` 关键字从 npm 采集的 1800+ 个包；作者若自己声明了
  简介，就用作者的原话。
- **一次确认完成安装**。未经评审的插件需要先显式确认，因为装上之后它与内置插件权限等同：
  你的文件、你的 shell、以及发往模型的请求。
- **启停**已安装的插件，无需重启。
- **发现过期安装**，与目录中的当前版本比对。

## 结构

一个包，两半：

- **Host**（`dsh-plugin-shop`）——通过网络取目录，用指针里的 sha256 校验，缓存，并在
  per-profile 互斥锁下执行 `dsh plugin add`。它只暴露五个 `store/*` Remote 方法，别无其他。
- **Client**（`dsh-plugin-shop/client`）——设置页标签。它既不碰网络也不碰文件系统，一切副作用
  都经由那五个方法。

## 目录

每日从公共 npm registry 构建，以静态 JSON 发布：

- `https://LivXue.github.io/dsh-plugin-shop/v1/index.json` —— 指针，携带
  `schemaVersion`、`builtAt` 和内容哈希
- `https://LivXue.github.io/dsh-plugin-shop/v1/plugins.<sha256>.json` —— 数据

用 `DSH_STORE_CATALOG_URL` 可以指向你自己的镜像。

## 不作何承诺

出现在货架上不等于背书。`capabilities` 只是作者对自己包的自述——v0 没有沙箱，界面也从不把它
渲染成一份被强制执行的权限清单。`verified` 层的含义是有人读过**那个确切版本**；一旦发布更新
版本就降级为 `verified-stale`，评审记录仍钉在它当初对应的版本上。

## 面向插件作者

想用自己的文案上架，声明 `dsh.catalog` 段：
[docs/schema.zh.md](https://github.com/LivXue/dsh-plugin-shop/blob/main/docs/schema.zh.md)。

## 许可

MIT

# 安全策略

[English](SECURITY.md) | 中文

这里会收到两类不同的报告。两类都走私下渠道，都不该出现在公开 issue 里。

## 商店或流水线本身的漏洞

走 GitHub 的私密公告表单：

> <https://github.com/LivXue/dsh-plugin-shop/security/advisories/new>

本仓库已经开启私密上报，所以不需要邮箱，报告在修复出来之前一直是私密的。请附上版本
（`npm view dsh-plugin-shop version`，或者你所在的 commit）、攻击者能拿到什么，以及你
手上最小的复现。

支持范围：npm 上 `latest` 解析到的那个版本。没有长期支持分支——修复以新版本的形式发布，
其中会改变宿主读取内容的那种改动先走 `beta` 标签。

## 目录里的恶意插件

目录收录的是第三方包。本项目负责收割和把关，但不为没人读过的代码背书。每个条目上的
信任层级记录的正是「谁读过」：`verified` 表示有人审阅过某一个确切的制品，
`verified-stale` 表示那次审阅覆盖的版本和现在提供的不是同一个，`community` 表示无人
看过。`registry/verified.yml` 今天是空的，所以对整个货架来说，诚实的答案是 `community`。

如果某个已上架的插件是恶意的，用同一个私密表单。**不要**开公开 issue，也不要提一个把它
加进 `denied.yml` 的 PR：万一判断错了，公开指控对那个包不公平；万一没判断错，公开指控
等于通风报信。请附上确切的包名和版本、有仓库的话附上仓库，以及那段代码究竟做了什么。
经确认的报告会变成 `denied.yml` 里一条写明理由的记录，而那条记录是永久的。

## 哪些不算安全报告

- **插件没在目录里。** 那是上架问题。
  [构建报告](https://LivXue.github.io/dsh-plugin-shop/v1/report.md)会逐包说明原因，
  [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md) 说明接下来怎么做。
- **插件标着 `community`。** 这个层级从不声称代码被读过。它标记的是「没有审阅」这件事
  本身，不是一张健康证明。

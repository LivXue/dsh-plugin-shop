# dsh-plugin-store 设计

状态：已评审，待实施计划
日期：2026-08-18

## 1. 背景

DeepSeek Harness（dsh）的一切能力都是 Cordis 插件，用户通过 profile 叠加 bundle 层来组合自己的运行时。安装通道已经存在——`dsh plugin --profile <p> add <spec>` 是一个 pnpm 转发器，跑完后按**已安装状态**回填 profile 的 `dsh.profile.bundles`。

缺的不是安装机制，而是三样东西：

- **发现**：没有 catalog，用户无从知道有哪些插件存在。
- **信任**：没有来源分级，装一个插件等于完全信任一段陌生代码。
- **界面**：没有浏览、启停、更新的可视化入口。

dsh-plugin-store 补齐这三样。

## 2. 目标与非目标

### 目标

- 一个**公开社区**插件市场：任何人发布到 npm 即可被发现，无需向本项目提交任何东西。
- 一个 **git 内可审计**的 catalog：每日变化可 diff、可 review、可回滚、可追责。
- 一个**分层信任**模型：人工审核过的与未审核的在界面上必须可区分，且审核结论绑定到具体版本。
- 一个**零特权的浏览器界面**：UI 被攻破不等于运行时被攻破。

### 非目标（明确不做，不是遗漏）

- **不做沙箱。** 插件 mount 后拥有完整 `ctx`——文件系统、shell、模型请求流。安装即完全信任。dsh-plugin-store 不改变这一点，只负责在安装前如实告知。
- **不防 npm 自身被攻陷。**
- **不做下载量、评分、评论。** 这些需要服务端与反滥用体系，在插件数量到达千级之前是纯负债。
- **不提供"从任意 URL 安装"。** 该能力保留在 CLI，理由见 §5.3。

## 3. 术语

| 术语 | 含义 |
|---|---|
| catalog | 由 `registry/` 每日构建产出的插件条目集合（静态 JSON） |
| entry | catalog 中的一条插件记录 |
| tier | 一条 entry 的信任层级：`verified` / `verified-stale` / `community` |
| profile | dsh 的运行时组合，位于 `$DSH_HOME/profiles/<name>` |
| bundle | 声明了 `dsh.bundle` 的 npm 包，安装后成为 profile 的一个 patch 层 |
| 用户层 | profile 目录下的 `cordis.patch.yml`，dsh 会热重载它 |

## 4. 已定决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 公开社区市场，自建 registry | 生态数据归项目所有，不依赖第三方 catalog 的可用性与治理 |
| D2 | 插件元数据靠 **npm keyword 自动抓取** | 作者发包即上架，零人工；上架无摩擦是社区市场能起量的前提 |
| D3 | **verified / community 分层**信任 | 自动抓取必然引入未审核的包；不能既要零摩擦又假装全都安全 |
| D4 | store 本身是 **out-of-tree bundle** | 独立发布节奏，不受 dsh 主仓 gate 约束；已验证 v0 无需任何上游改动 |
| D5 | catalog 是**静态 JSON + 每日 CI**，不是服务端 | 零运维；且让 catalog 成为 git 里的可审计产物，这是本方案相对服务端方案的核心价值 |
| D6 | catalog 由 **Host 代取并落盘缓存**，不由浏览器直连 | 避开 CORS/CSP；支持离线降级与内网镜像；把网络出口收敛成一个可审计的点 |

## 5. 架构

### 5.1 组件与仓库布局

本仓单仓两目录。`registry/` 是纯数据与构建脚本，`plugin/` 是发布到 npm 的插件包；两者无代码依赖，仅共享 §6 的 schema。

```
registry/
  schema/plugin-entry.schema.json   catalog 条目 schema，带 schemaVersion
  verified.yml                      人工白名单（钉版本）
  denied.yml                        封禁名单
  allowed-similar.yml               近似名称的显式放行
  snapshots/manifest.lock           每日提交的 名称→版本→integrity 快照
  scripts/build.ts                  harvest → validate → merge → emit
plugin/                             npm 包 dsh-plugin-store
  src/host/                         StoreGateway
  src/client/                       浏览器半边
.github/workflows/daily.yml         每日 + PR 触发 registry 构建
```

**R — `registry/`（纯数据，无运行时代码）**

产物发布到 CDN：`/v1/index.json`（指针）与 `/v1/plugins.<sha256>.json`（数据）。指针与数据分离，使客户端可长缓存数据文件而只轮询几百字节的指针。

**S — `plugin/`（发布到 npm 的 `dsh-plugin-store` 包，两个半边）**

- **Host 半边** `StoreGateway`：注册 `store/*` Remote。它是唯一接触网络与 profile 目录的地方。
- **Client 半边** `dsh-plugin-store/client`：走 `dsh.client` 约定，`ctx.remote.$mount()` 挂载 store 的 Remote，向 `settings.plugins.tab` 插入一个 tab。**不接触网络，不接触文件系统。**

**上游 dsh：v0 零改动。**

### 5.2 为什么 out-of-tree 可行（已验证）

| 能力 | 结论 | 依据 |
|---|---|---|
| 浏览器半边能被加载 | ✅ | `client/modules` 的 Node 半边扫描 enabled Loader entries 中带 `dsh.client` 的包，解析 `exports["./client"]`，哈希进 boot graph 并从 `/plugins` 提供服务 |
| 能注册自己的 RPC | ✅ | `ctx.remote.$mount()` 是公开的；`dsh-typert-loader` 在 Loader composition 中发现并注册生成的 host artifacts |
| 能读已安装插件列表 | ✅ | `pluginInventory/list` 返回 entry id、specifier、启用状态、Fiber phase |
| 能改已安装插件 | ❌ 需自建 | `host/plugin-inventory` README 明示 "cannot enable, disable, add, or remove plugins" |
| 能暴露自己的 settings 命名空间 | ❌ 被 allowlist 拦 | `WEB_SETTINGS_NAMESPACES` 是 `api-proxy.ts` 里的硬编码常量 |
| 能向浏览器推送事件 | ❌ 被 allowlist 拦 | `API_REMOTE_FORWARDED_EVENTS` 是 `api/remotes/src/remote-events.ts` 里的硬编码数组 |

后两条不阻塞 v0：store 用自己的 `store/*` Remote 而非 settings 命名空间；进度用轮询而非推送（§7.2）。

### 5.3 三条边界硬线

1. **Client 半边零特权。** 它能做的一切就是 §7.3 那五个 `store/*` 方法。UI 被 XSS 打穿，攻击面也只是这五个方法的参数。
2. **Host 只接受包名与版本，不接受任意 spec。** `store/install` 的参数是 `{ name, version }`，不是 pnpm 命令行。Host 用自己缓存的 catalog 快照校验后自行构造 spec。
3. **catalog 快照是 Host 的真相源。** 浏览器传包名，Host 用自己的快照判定，不信任浏览器传来的任何元数据。

硬线 2 的直接后果：**store UI 中永远不存在"从 GitHub URL 安装"按钮**。该能力只在 `dsh plugin add` CLI 中，因为它需要用户显式开启 `allowBuilds` 并显式钉 commit SHA，这两个动作不适合做成一次点击。

## 6. Catalog 数据模型

### 6.1 插件作者声明

作者只改自己的 `package.json`：

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

两个标识符**刻意保持生态中性，不带 store 品牌**：

- keyword 用 `dsh-plugin`，不用 `dsh-plugin-store`。作者声明的是"我是一个 dsh 插件"，不是"我要上你的架"。
- 字段用 `dsh.catalog`，不用 `dsh.store`。`dsh` 是 DeepSeek 的命名空间（其 JSDoc 写明 "other consumers own additional keys"，故加 key 被许可），但加一个以本项目命名的 key 等于在别人的命名空间挂自己招牌。`catalog` 描述数据本身是什么，第二个 store 出现时可直接复用同一份数据——这对一个公开社区市场才是诚实的做法。

`category` 是封闭枚举：`tool` | `provider` | `ui` | `workflow` | `integration` | `other`。

`capabilities` 是**作者自述，非强制**。v0 不做沙箱，故它只用于展示。UI 必须避免让它读起来像一份被执行的权限清单——虚假的安全感比没有安全感更糟。

### 6.2 catalog 产物

`/v1/index.json`：

```json
{
  "schemaVersion": 1,
  "builtAt": "2026-08-18T00:00:00Z",
  "count": 137,
  "plugins": { "url": "plugins.<sha256>.json", "sha256": "<sha256>" }
}
```

`/v1/plugins.<sha256>.json`：

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "name": "dsh-hello-plugin",
      "version": "1.2.0",
      "integrity": "sha512-...",
      "publishedAt": "2026-08-01T12:00:00Z",
      "repository": "https://github.com/you/hello-plugin",
      "license": "MIT",
      "tier": "verified",
      "review": {
        "reviewedVersion": "1.2.0",
        "reviewer": "github:someone",
        "reviewCommit": "abc1234",
        "notes": "..."
      },
      "catalog": {
        "category": "tool",
        "summary": { "en": "...", "zh": "..." },
        "capabilities": ["fs", "shell"]
      }
    }
  ]
}
```

`builtAt` **只出现在 index.json，绝不进入被哈希的内容**。否则每日 hash 都变，CDN 缓存全失效，git diff 全是噪声。

## 7. 数据流

### 7.1 Catalog 构建（每日 + PR 触发）

```
harvest → fetch manifest → gate → tier → emit → commit 快照
```

1. **Harvest**：`registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin`，分页取全量候选包名。**按 keyword 抓取，不按包名模式抓取**——名称模式是可仿冒的。
2. **Fetch manifest**：逐个取 packument 的 latest，读 `dsh.bundle`、`dsh.catalog`、`version`、`dist.integrity`、`repository`、`license`、`deprecated`。
3. **Gate（准入）**：每条淘汰都必须在构建报告中留下**作者可读的原因**。
   - 无 `dsh.bundle` → 是库不是插件，排除。这与 CLI 的 "declares no dsh.bundle" 警告同一判据。
   - `dsh.catalog` 缺失或不过 schema → 排除。
   - 命中 `denied.yml` → 排除。
   - npm 已标记 deprecated → 排除。
   - 无 license 或无 repository → 排除。理由不是洁癖：没有仓库地址就无法审计，而一个想上架的正经插件不会藏源码。
   - 与 `verified.yml` 中任一名称的 Levenshtein 距离 ≤ 2 且不等于 0 → **卡住等人工裁决**（进 `denied.yml` 或写入 `allowed-similar.yml` 显式放行），不自动上架。这是 typosquatting 的闸门。阈值 2 是起点，可依实际误报率调整；调整它要改的是常量与其测试，不是流程。
4. **Tier 标注**：与 `verified.yml` 求交。

   > **verified 必须钉版本，不能挂包名。**

   `verified.yml` 记录 `{ name, reviewedVersion, reviewer, reviewCommit, notes }`。构建时若 npm latest 高于 `reviewedVersion`，该条目**降级为 `verified-stale`**，UI 显示"已审核 v1.2.0 / 当前 v1.3.0 未审核"。

   绝大多数市场把 verified 挂在包名上，结果是作者审核通过后再发一个恶意版本即自动继承信任——这是供应链攻击最省力的入口。
5. **Emit**：按包名字典序排序（保证确定性），产出 `plugins.<sha256>.json` 与 `index.json`；构建报告作为 CI artifact。
6. **Commit 快照**：把 `manifest.lock`（名称 → 版本 → integrity）提交回本仓 `registry/snapshots/`。

   **这一步是本方案相对服务端方案的全部价值所在。** 少了它，方案就退化成"一个跑在 CI 上的黑盒服务端"。

### 7.2 安装流

```
Browser                     Host (StoreGateway)                    子进程
  │ store/install {name, version, acknowledged?}
  │─────────────────────────────▶│
  │                              │ ① 查 Host 缓存的 catalog 快照
  │                              │    不在      → not-in-catalog
  │                              │    denied   → denied
  │                              │    版本不符  → version-mismatch
  │                              │ ② tier≠verified 且 !acknowledged
  │                              │              → needs-acknowledgement
  │                              │ ③ spec = `${name}@${version}`（钉死）
  │                              │ ④ 取 per-profile 互斥锁
  │◀──── { installId } ──────────│ ⑤ spawn dsh plugin --profile <p> add <spec>
  │                              │────────────────────────────────▶│
  │  store/installStatus 轮询 ───▶│◀──────── stdout/stderr ─────────│
  │◀──── { state, log[] } ───────│ ⑥ exit 0 → 读回 manifest 确认 bundles 变化
  │◀──── { done, needsRestart } ─│
```

实现决策：

- **版本钉死**：spec 是 `name@version`，不是 `name`，更不是 `^version`。用户点的是快照里那个版本，装的必须是同一个。
- **spawn 而非重实现**：`dsh` 自身的 `stdio: 'inherit'` 会继承我们给的 pipe，所以流式日志天然可得，无需上游改动。编排逻辑（init → pnpm → reconcile）住在 `apps/cli/src/plugin.ts` 的 `runPlugin`，**未从任何 package 导出**；`dsh-app-boot` 只导出原语。抄一份 reconcile 会漂移，且其"按已安装状态而非依赖 diff"的语义很微妙，不值得复制。
- **进度靠轮询而非推送**：`API_REMOTE_FORWARDED_EVENTS` 是仓内硬编码数组，仓外插件无法向浏览器推事件。`store/install` 立即返回 `installId`，客户端每秒轮询 `store/installStatus`。副作用是它天然抗页面刷新。
- **per-profile 串行**：pnpm 自己有锁，但并发时的报错对用户完全不可读。Host 侧一个 profile 一把锁。
- **失败不自动回滚**：pnpm 失败后 `dsh.profile.bundles` 不会错乱（reconcile 只在 exit 0 时运行），但 `dependencies` 可能已被改写。策略是原样回吐 stderr 并提示运行 `dsh plugin --profile <p> install` 修复。**自动回滚一个包管理器的中间状态，比不回滚更容易破坏用户环境。**
- **`allowBuilds` 永不由 store 写入**：pnpm ≥10 默认拦截构建脚本，这是白捡的安全属性。需要构建脚本的插件在 store 中就是装不了，UI 直说"该插件需在 CLI 中手动授权构建"并给出命令。

### 7.3 RPC 契约

| 方法 | 参数 | 返回 |
|---|---|---|
| `store/catalog` | `{ refresh?: boolean }` | `{ schemaVersion, builtAt, stale, plugins[] }` |
| `store/install` | `{ name, version, acknowledged? }` | `{ installId }` |
| `store/installStatus` | `{ installId }` | `{ state, log[], needsRestart? }` |
| `store/setEnabled` | `{ name, enabled }` | `{ ok }` |
| `store/outdated` | — | `{ name, installed, latest }[]` |

## 8. 生效语义

| 操作 | 是否需要重启 | 依据 |
|---|---|---|
| 启用 / 停用 | **否，热生效** | `watchUserPatches` 监听 profile 的 `cordis.patch.yml`，刷新时经 HMR 走 `entry.update({config:{patches}})` |
| 安装 / 卸载 | **是，必须重启** | bundle 层来自 profile `package.json` 的 `dsh.profile.bundles`，boot 时读取，watch 不覆盖 |

已排除的做法：装完后把该插件的行直接 insert 进用户层以求免重启。**不可行**——下次 boot 时 `dsh.profile.bundles` 中已有它（`dsh plugin` 的 reconcile 按已安装状态回填），同一组 row 会挂载两遍。

**v0 不提供重启端点。** 安装成功后 UI 显示"已安装，重启 dsh 后生效"。

理由：给一个浏览器可达的面增加"重启服务进程"的 RPC，是拿可用性换一次点击的便利。启停已经是热的，安装本就是低频动作。若日后要做，也应是**默认关闭的 opt-in 配置 + 仅 loopback**，而非 v0 的默认能力。

## 9. 安全模型

### 9.1 威胁模型

**防这些：**

| 攻击者 | 手法 |
|---|---|
| 恶意作者 | 发布带 `dsh-plugin` keyword 的后门插件 |
| 仿冒者 | typosquatting：`dsh-fs-tools` 冒充 `dsh-fs-tool` |
| 被攻陷的合法插件 | 作者 npm 账号被盗，或其依赖链被投毒 |
| catalog 中间人 | 劫持 CDN/DNS，篡改 `plugins.json` |
| 打 store 本身 | 通过 catalog 文本注入攻击浏览器半边 |

**明确不防：** 已安装插件的运行时行为；npm 自身被攻陷。

### 9.2 对策

| 威胁 | 对策 | 剩余风险 |
|---|---|---|
| 恶意作者 | verified 分层；community 强制二次确认 | community 层本身有风险，只能靠如实告知 |
| typosquatting | 构建期编辑距离检测，命中则卡住等人工裁决 | 新颖仿冒手法 |
| 账号被盗 / 恶意新版本 | verified 钉版本；`manifest.lock` 记 integrity，版本与哈希变化在 git diff 中一眼可见 | 发现有延迟 |
| catalog 中间人 | `index.json` 指向内容寻址的数据文件，Host 拉取后校验 sha256 与 index 一致；本仓 git 历史是第二真相源 | `index.json` 自身被换，靠 HTTPS 兜底 |
| catalog 文本注入 | Client 零特权；`summary`/`description` 一律按纯文本渲染，不过 Markdown、不渲染链接 | — |
| 安装期代码执行 | pnpm ≥10 默认拦截构建脚本，store 永不写 `allowBuilds` | 用户此前手动开启过的条目 |

### 9.3 二次确认的措辞

community 层确认弹窗必须表达这个意思：

> 安装后，该插件将获得与内置插件相同的权限：读写你的文件、执行 shell 命令、读取和修改发往模型的请求。它未经审核。

依据是 dsh 自身对 `allowBuilds` 的定性——"permission to execute the package's code on your machine at install time, outside any sandbox the agent runs under"。沿用上游措辞，不另发明一套。

禁止使用"该插件来自社区，请谨慎安装"这类零信息量表述。

## 10. 失败模式

| 失败 | 表现 | 处理 |
|---|---|---|
| catalog 拉不到（离线/CDN 故障） | 使用磁盘缓存的上一份快照，显示"数据截至 X" | **降级可用，不算错误** |
| catalog `schemaVersion` 高于客户端支持 | 拒绝加载，提示升级 dsh-plugin-store | **失败要响**，不静默降级 |
| pnpm 不在 PATH | CLI 已有 exit 127 的诊断 | 原样透出 |
| pnpm 安装失败 | 原样 stderr + `dsh plugin --profile <p> install` 修复提示 | 不自动回滚 |
| 安装成功但 `bundles` 未变 | 说明装的是库而非插件（gate 本应拦住） | 报"catalog 数据已陈旧"并强制刷新 |
| profile 不存在 | `dsh plugin` 自动 init | 无需处理 |
| 并发安装同一 profile | 后到者等锁 | 互斥锁 |

## 11. 测试与验收

dsh-plugin-store 在 dsh 主仓之外，不受其 100% coverage / invariant / doc-sync 约束。以下四条是刻意采纳的：

1. **`build.ts` 必须是纯函数**：输入 npm 响应 fixture，输出 JSON。gate 每条规则一个 case，外加**确定性测试**——同一输入跑两次产物 byte-identical。该测试直接保护 §6.2 中 "`builtAt` 不进 hash" 的决定。
2. **拒绝路径必须打到执行器**：`not-in-catalog` / `denied` / `version-mismatch` / `needs-acknowledgement` 各一个测试，直接调用 `store/install`，而非测试 UI 是否禁用了按钮。依据 dsh 的原则："facades, wrappers, and listener order are not enforcement when direct or alternate callers can bypass them; test denial through the executor."
3. **一个真安装的组合测试**：临时 `DSH_HOME` + 一个 fixture 插件包（`file:` spec 即可，无需架设 verdaccio），跑完断言 profile `package.json` 的 `dsh.profile.bundles` 确实新增了一项。
4. **XSS 回归**：catalog fixture 中放入 `summary` 为 `<img src=x onerror=...>` 的条目，断言渲染为文本。

## 12. 分期

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| P0 | R：schema + build.ts + CI + 首次产物 | catalog 可被 curl 到，确定性测试通过 |
| P1 | S Host 半边：`store/catalog` + `store/install` + `store/installStatus` | 真安装组合测试通过 |
| P2 | S Client 半边：浏览、详情、安装、二次确认 | XSS 回归通过；能在 web profile 中走通全流程 |
| P3 | 启停（热）+ `store/outdated` | 启停无需重启即生效 |

P0 先行的理由：schema 一变，Client 全部返工。P1 次之，因为它是唯一会真正失败的部分（子进程、profile 状态），越早验证越好；UI 反而最容易改。

## 13. 上游可选 PR（均不阻塞 v0）

| # | 内容 | 收益 |
|---|---|---|
| U1 | 将 `runPlugin` 提升到 `dsh-app-boot`，stdio 可注入 | store 可直接调库，省掉定位 `dsh` 可执行文件 |
| U2 | 把 settings 命名空间暴露从 `WEB_SETTINGS_NAMESPACES` 移到 `settings.register()` | 仓外插件可自曝配置卡片（该文件自身已将此列为 deferred work） |
| U3 | 允许仓外插件注册转发事件 | 安装进度可改为推送 |
| U4 | `pluginInventory` 增加写路径 | store 不必自行编排 profile 变更 |

## 14. 已知限制与延后事项

- **capabilities 是自述的，不被强制。** v0 无沙箱。UI 措辞必须避免让它读起来像一份被执行的权限清单。
- **verified 依赖人工投入。** 若无人审核，全部条目停留在 community 层，store 退化为一个带界面的 awesome-list。这是运营问题，不是技术问题，但会决定产品价值。
- **无重启端点**（§8）。
- **无下载量、评分、评论**（§2）。
- **单一 catalog 源。** 内网镜像可通过配置替换 URL，但 v0 不做多源合并。

## 15. 附录：本设计引用的 dsh 代码位置

| 事实 | 位置 |
|---|---|
| `dsh plugin` 编排与 reconcile 逻辑 | `apps/cli/src/plugin.ts` |
| profile 与 bundle manifest 定义 | `packages/boot/app-boot/src/profile.ts` |
| 用户层热重载范围 | `packages/boot/app-boot/src/index.ts` 的 `watchUserPatches` |
| 仓外 client 半边的加载方式 | `packages/client/modules/README.md` |
| 只读插件清单及其限制 | `packages/host/plugin-inventory/README.md` |
| settings 命名空间 allowlist | `packages/host/apiproxy/src/api-proxy.ts` 的 `WEB_SETTINGS_NAMESPACES` |
| 转发事件 allowlist | `packages/api/remotes/src/remote-events.ts` |
| `allowBuilds` 的安全定性 | `docs/user/develop/basic/publish.md` |

# Catalog schema

[English](schema.md) | 中文

插件通过在 `package.json` 里声明 `dsh-plugin` keyword 和 `dsh.catalog` 段来上架。机读 schema 是 [`registry/schema/plugin-entry.schema.json`](../registry/schema/plugin-entry.schema.json)，由构建实际使用的校验器生成，因此不会与实际执行的规则脱节。

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

| 字段 | 必填 | 含义 |
|---|---|---|
| `category` | 是 | `tool`、`provider`、`ui`、`workflow`、`integration`、`other` 之一 |
| `summary.en` | 是 | 一行，1–200 字符。不会被合成：缺了就是缺了 |
| `summary.zh` | 是 | 同上，中文 |
| `capabilities` | 是 | 至多 20 个自由字符串，说明插件用到的 dsh 服务 |

**`capabilities` 是作者自述，不被强制执行。** dsh 不对插件做沙箱隔离，因此该字段只是作者声称插件会碰什么。它只用于展示，不会被校验。**不要把它当成权限授予来读。**

未知字段会被拒绝而不是忽略，所以拼错字段名会让构建失败并指出是哪个字段，而不是悄悄丢掉你的数据。

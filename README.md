# omp-extensions

cnzgray 的 Oh My Pi 扩展市场。

## 安装

```bash
omp plugin marketplace add cnzgray/omp-extensions
omp plugin discover
omp plugin install claude-auto-memory@omp-extensions
```

## 插件

| 插件 | 说明 |
| --- | --- |
| `claude-auto-memory` | 自动生成的项目记忆(Claude Code 风格) |
| `claude-rules-bridge` | 把 `.claude/rules/*.md` / `*.mdc` 桥接为 omp 路径作用域规则 |

## 本地开发

```bash
omp plugin link ./claude-auto-memory    # 或 claude-rules-bridge
# 改代码 → 重启 omp 会话生效
```

注意: marketplace 安装不装依赖,`claude-rules-bridge` 的运行时依赖 picomatch 已 vendor 在 `claude-rules-bridge/vendor/`。

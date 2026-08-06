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
| `ponytail` | 懒人模式: 强制使用最简单可行方案(vendored hooks,不依赖 Claude Code 安装) |
| `claude-auto-memory` | 自动生成的项目记忆(Claude Code 风格) |
| `claude-rules-bridge` | 把 `.claude/rules/*.md` / `*.mdc` 桥接为 omp 路径作用域规则 |

## 本地开发

```bash
omp plugin link ./ponytail          # 或 claude-auto-memory / claude-rules-bridge
# 改代码 → 重启 omp 会话生效
```

注意: marketplace 安装不装依赖。运行时依赖已 vendor 在各包内:
`ponytail/vendor/`(hooks + SKILL.md 指令文本)、`claude-rules-bridge/vendor/`(picomatch)。

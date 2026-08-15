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
| `deepseek-v4-anchor` | DeepSeek V4 Pro 首请求锚定：Minimal system prompt + 精确 `bash` / `str_replace_editor` 工具协议；回复后恢复 OMP 工具与上下文 |

`deepseek-v4-anchor` 安装后自动匹配各 provider 下的 `deepseek-v4-pro`（含日期/tag SKU）。
仅空白会话首请求和成功压缩后的首请求进入严格锚定；该请求会临时移除 OMP/项目系统上下文，
并只暴露 DeepSeek Harness Minimal 的 `bash` 与 `str_replace_editor` 协议。首个 assistant 消息落盘后，
后续请求恢复正常 OMP system prompt 与工具目录。支持 OpenAI Responses、Anthropic Messages，
并兼容 OpenAI Chat Completions。

## 本地开发

```bash
omp plugin link ./ponytail          # 或 claude-auto-memory / claude-rules-bridge
# 改代码 → 重启 omp 会话生效
```

注意: marketplace 安装不装依赖。运行时依赖已 vendor 在各包内:
`ponytail/vendor/`(hooks + SKILL.md 指令文本)、`claude-rules-bridge/vendor/`(picomatch)。

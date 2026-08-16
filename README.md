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
| `deepseek-v4-anchor` | DeepSeek V4 Pro 两阶段锚定：Minimal 首请求；晋升后保持 persona-first resident 工具集并按需解锁 |

`deepseek-v4-anchor` 安装后自动匹配各 provider 下的 `deepseek-v4-pro`（含日期/tag SKU），
但行为锚定仅在 OpenAI Responses 协议启用；其他协议保持原请求并告警。空白会话首请求只暴露
DeepSeek Harness Minimal 的 `bash` 与 `str_replace_editor` 协议。首个成功 assistant 消息完成后，
后续请求保持 Minimal persona 打头，并只暴露 resident 集：上述两工具加 `dev_tool_search`。
模型可通过 `dev_tool_search` 搜索并持久解锁其他 OMP 工具；resume、分支和树导航会从 session
entries 恢复解锁集。成功压缩后先进入 Minimal 工具加 `read`/`write`/`edit`/`glob`/`grep`/
`todo`/`ask` 的受控 epoch，产生新 assistant 消息后再回到 resident 集。

## 本地开发

```bash
omp plugin link ./ponytail          # 或 claude-auto-memory / claude-rules-bridge
# 改代码 → 重启 omp 会话生效
```

注意: marketplace 安装不装依赖。运行时依赖已 vendor 在各包内:
`ponytail/vendor/`(hooks + SKILL.md 指令文本)、`claude-rules-bridge/vendor/`(picomatch)。

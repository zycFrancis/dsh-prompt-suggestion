# dsh-prompt-suggestion

[English](./README.en.md)

Claude Code 风格的**输入建议**插件 for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness):每个回合结束后,输入栏以灰色 ghost text 显示下一条建议输入,按 **Tab** 采纳为真实值(可直接回车发送),按 **Esc** 关闭,开始输入即消失。

```
┌──────────────────────────────────────────────┐
│  跑一下测试并修复失败的用例   [Tab]          │  ← 灰色 ghost text + Tab 提示
└──────────────────────────────────────────────┘
```

## 工作方式

- **Host 半**监听会话事件:`turn/end` 后延迟数百毫秒,把最近 N 轮 user/assistant 文本交给一次**独立的轻量 LLM 请求**(不进会话日志、不带工具、不占上下文)生成一条简短建议;`user/message` 或会话重新开始运行时,建议立即失效。
- **Client 半**通过 `conversation.input.overlay` 挂进 composer 卡片,把建议以 React portal 渲染到编辑器内,对齐宿主 placeholder 的定位与字体;ghost 可见时自动隐藏宿主 placeholder,主题完全使用 `--dsw-alias-*` token,明暗主题自适应。
- **Tab 采纳**在 `keydown` 捕获阶段处理(先于 Lexical keymap),命令菜单(`/`、`@` 候选)打开时自动让位;采纳后调用宿主 `inputActions.setDraft`,焦点留在输入框,回车即发。
- 跨进程通信走 DSH 的 Typert RPC:Host 提供 `promptSuggestion` 服务(`get`/`dismiss`),Client `$mount` 对应命名空间,与官方插件同一套规范。

## 安装

```bash
# 方式一:本地路径安装
dsh plugin install /path/to/dsh-prompt-suggestion

# 方式二:从 GitHub 安装
dsh plugin install zycFrancis/dsh-prompt-suggestion
```

安装后**刷新一次 Web 页面**以加载 Client 模块。新回合结束后即可看到建议。

## 配置

安装后在 profile 的 `cordis.patch.yml` 中覆盖(或在 `dsh plugin` 管理页配置):

```yaml
- id: prompt-suggestion
  name: dsh-prompt-suggestion
  config:
    enabled: true          # 总开关
    provider: deepseek     # 可选:显式指定生成模型路由
    model: deepseek-chat   #       省略时依次回退:会话最近一次请求路由 → 全局默认模型
    historyTurns: 4        # 参与生成的最近回合数
    maxInputChars: 6000    # 送入模型的对话文本上限(字符)
    maxOutputTokens: 4096   # 建议请求的 max tokens(思考型模型需容纳思考内容)
    delayMs: 600           # turn/end 后延迟预生成的毫秒数(0 为立即)
```

## 行为细节

| 场景 | 行为 |
| --- | --- |
| 回合结束、输入栏为空 | 延迟预生成;Client 轮询拉取,约 0.4–3s 内出现 |
| 按 Tab | ghost 变为真实输入,焦点保留,可直接发送 |
| 按 Esc | 本次建议关闭,同回合不再出现 |
| 输入任意字符 / 粘贴 | ghost 消失 |
| 发送新消息 / 回合开始 | Host 侧缓存立即失效并中止进行中的生成 |
| 命令菜单打开 | Tab 归菜单;菜单关闭后 ghost 仍在 |
| 切换会话 | 各会话建议独立;返回时仍在(本回合内) |
| 无可用模型路由 | 静默失败,不影响任何宿主功能 |
| 思考型模型(如 GLM-5.3) | 自动请求最低推理档,输出上限默认 4096 容纳思考 |

建议生成消耗对应模型路由的少量 token(每次约几百 token 输入、几十 token 输出);不想要时设 `enabled: false` 或卸载。

## 开发

```bash
pnpm install
node --test test/unit.mjs
```

- `lib/index.js` — Host 半:事件接线、对话收集、LLM 生成、RPC 服务。
- `lib/typert.host.js` — Typert 清单(zod v4 codec)。
- `lib/client.js` — Client 半:Remote 贡献、ghost text 组件、键盘处理。

修改 Host 半代码后重载插件即可;修改 Client 半需要刷新页面。

## License

MIT

# Changelog

## 0.1.0 (2026-10-09)

首个公开版本:Claude Code 风格的 DSH 输入建议插件。

### 功能

- 回合结束后延迟预生成下一条输入建议(独立轻量 LLM 请求,不进会话日志)
- 输入栏灰色 ghost text 展示 + Tab 徽标;对齐宿主 placeholder 定位,明暗主题自适应
- Tab 采纳为真实输入(可直接发送)、Esc 关闭、任意输入消失、命令菜单打开时让位
- 会话事件驱动的缓存失效(新输入/回合开始/会话移除),Typert RPC 双面清单
- 模型路由三级回退:显式配置 → 会话最近请求路由 → 全局默认模型

### 调试历程中修复的关键问题

- typert 清单缺 `model`、codec 形状不符 loader 文法(注册必失败)
- Client RPC 贡献 codec 缺 `mode: 'strict'`($mount 必抛)
- 思考型模型(GLM-5.3)三层适配:请求最低推理档、4096 输出上限、思考流尾段兜底提取正文
- `resolveModelInfo` 无超时挂起会永久阻塞生成链(5s 超时兜底)
- 键盘处理不再劫持 composer 之外编辑区的 Tab
- Host 服务与监听挂载到 inject 子上下文,llm 重载不产生双份监听

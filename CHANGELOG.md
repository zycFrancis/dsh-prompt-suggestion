# Changelog

## 1.1.0 (2026-10-09)

规范合规强化版本:对照 DSH 官方插件开发规范逐项审计后,补齐显示元数据并消除两处渲染灰色地带。

### 新增

- 插件市场显示元数据:`locale/en.json` + `locale/zh.json`(title/description)与 `icon.svg`(933B ghost text 图标),Plugin Manager 卡片、bundle 详情与 Settings inventory 现在显示本地化标题与图标

### 变更

- 样式注入改为 React `<style>` 元素随组件渲染,卸载自动移除(原先 `document.head.append` + 手动清理)
- ghost 定位改为在插件自己的 overlay DOM 内渲染,通过对宿主 placeholder 的只读测量(getBoundingClientRect + computedStyle)对齐输入文本,窗口 resize 自动重测(原先 React portal 进宿主编辑器容器)
- 键盘处理收紧作用域:Tab/Esc 只响应 ghost 所在卡片的输入栏

### 验证

- 规范对照 20 项硬性条目 + 2 项原灰色地带全部合规
- 单元测试 8/8;真实回合回归通过(deepseek-flash,建议语义精准)

## 1.0.0 (2026-10-09)

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

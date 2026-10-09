# 让建议生成"完整跟随"当前会话:一次 DSH 插件路由设计的演进笔记

> 本文记录 [dsh-prompt-suggestion](https://github.com/zycFrancis/dsh-prompt-suggestion)(Claude Code 风格输入建议插件)中模型路由机制的设计过程:从"模型跟随、参数强制"到"完整跟随",以及这中间踩过的每一个坑。所有结论都有日志或测试背书,希望对写 DSH 插件、尤其是需要发起辅助 LLM 请求(标题生成、摘要、建议)的人有用。(English version: [routing-design-notes.en.md](./routing-design-notes.en.md))

## 1. 问题:同一个模型,两种"性格"

这个插件的核心动作,是在回合结束后发起一次**独立的轻量 LLM 请求**,为用户生成下一条输入建议。最初的路由实现是三级回退:

```
显式配置(provider/model) → 会话最近一次请求路由 → 全局默认模型
```

模型层面它已经"跟随会话"——用户切到 Kimi,建议就用 Kimi 生成。但思考档(`reasoningEffort`)是我强制取**该模型最低档**的,理由很充分:思考型模型的输出上限是"思考 + 正文"共享的,96 token 的上限会被思考瞬间耗光(这是开发中实打实踩过的坑,后文详述)。

于是出现了这样的割裂:用户正在用 GLM-5.3 + high 思考深入讨论,建议请求却以最低档生成——**同一个人工智能,两种性格**。用户的一句话点破了设计问题:

> "能不能改为和正在使用的模型保持一致。"

以及更根本的:

> "我看你在 GitHub 的配置里给了固定的 provider,不喜欢这种设置思路。"

第二条批评的是 README 示例:配置节把 `provider: deepseek` 当主推写法展示,等于鼓励用户钉死路由——与"跟随"的直觉背道而驰。

## 2. DSH 提供的路由事实

先讲机制。DSH 的会话日志里,每次模型请求都会留下 `request/header` 事件,其 `config` 字段承载完整的调用配置:

```json
{
  "provider": "zai-coding-cn",
  "model": "glm-5.3-flash",
  "reasoningEffort": "high",
  "maxTokens": 131072
}
```

Host 侧通过 `session.requestHeader()` 可以读到**最近一次**的这份配置(内部有 fold 缓存)。这就是"当前正在使用的模型"的权威来源——不是全局设置,而是这个会话刚刚真实发出的请求。

另外两个来源:

- `ctx.get('agentDefaultModel').currentSelection()` —— 全局默认模型(含可选 effort),仅在会话还没有任何请求头时兜底;
- 插件自己的 Config —— 用户显式覆盖。

## 3. 新设计:完整跟随 + 三层兜底

v1.2.0 的语义收敛为一句话:**默认一切跟随,显式配置只是偏离项**。

```
reasoningEffort 的解析顺序:

  会话最近请求的 effort          ← 新增:与对话行为一致
    ↓ 会话没写?
  该模型最低档(lowestReasoningEffort)
    ↓ 生成结果为空?
  完全不带档位重试
```

实现上,`resolveRoute` 把三个来源的 `reasoningEffort` 一并透传:

```js
// 会话路由
const route = session.requestHeader()?.config
return {
  provider: route.provider,
  model: route.model,
  ...typeof route.reasoningEffort === 'string'
    ? { reasoningEffort: route.reasoningEffort } : {},
}
```

Config 同步增加了可选的 `reasoningEffort`(与 provider/model 一起构成"初始化预设"面:留空即跟随,填写即覆盖),README 的配置节重写为"默认零配置"开篇。

## 4. 为什么兜底链不能省:这段路上踩过的坑

"跟随会话档"听起来只是少写一行覆盖,但它成立的前提是**降级路径足够健壮**。这些坑全部来自真实调试日志:

**坑 1:思考吃光输出上限。** 最初 `maxOutputTokens: 96`,GLM-5.3 上永远拿到空建议,finish 原因是 `max-tokens`——思考型模型把 96 token 全部花在了思考上,正文一个字没出。修复分两层:上限提到 4096,并且请求显式的最低推理档。

**坑 2:流协议是增量,不是块。** 修完上限,输出依然是 0 字符,但 finish 是正常的 `stop`。最终发现 `llm.stream` 的 chunk 是 `text-delta` / `reasoning-delta` 增量协议,而我按块级的 `type: 'text'` 聚合——永远匹配不到。更糟的是单元测试的 mock 用的也是错误形状,8/8 通过的测试反而掩盖了 bug。教训:**mock 必须复刻真实协议,而不是复刻你对协议的想象**。这也是为什么后来给聚合逻辑同时保留 `reasoning-delta`,正文为空时还能从思考流尾部提取结论。

**坑 3:模型信息解析挂起。** `resolveModelInfo`(查模型的 efforts 列表)没有超时,一旦适配器层面的请求挂起,整条生成链永久卡死,而且恰好卡在日志语句之前——表现为"什么都没发生"。现在带 5 秒超时,超时按无档位裸调。

有这三层修复打底,"会话档优先"才敢成为默认:即使某个模型的 high 思考真的把 4096 耗光,空输出降级链也会接住。

## 5. 跟随的边界:请求独立,互不污染

"完整跟随"不等于复制会话请求。建议请求有几条刻意保持的独立边界:

- **不进会话日志**——它是 `llm.stream` 的独立调用,带自己的 `purpose` 标记,不产生 session 事件;
- **不带工具**——纯文本进纯文本出;
- **maxTokens 独立**——默认 4096,不抄会话的 131072(抄了纯属浪费,输出上限只是天花板,不影响质量);
- **失效联动**——会话一旦有新 `user/message` 或重新开始运行,缓存立即作废、进行中的生成被 abort,过期建议永远不会出现。

## 6. 怎么验证"跟随"真的发生了

配置类逻辑最容易"看起来对"。两个层面的验证:

**跨模型实证**(开 `debugLog` 后的日志):同一个插件,桌面会话用 GLM-5.3 时打出 `generating via zai-coding-cn/glm-5.3`,Web 实例默认路由时打出 `generating via deepseek-official/deepseek-flash`——代码没变、结果随会话变,这是跟随的直接证据。

**行为单测**(不依赖运行环境):

```js
// mock 的 requestHeader 带 reasoningEffort: 'high'
assert.equal(seen[0].reasoningEffort, 'high')  // 透传到建议请求
// mock 不带 effort 时
assert.equal(seen[0].reasoningEffort, 'low')   // 解析到模型最低档
```

测的是"请求参数"而不是"建议文本",断言落在机制本身上。

## 7. 复用这条路径

如果你的插件也要发起辅助 LLM 请求(标题、摘要、命名、建议……),这条路径可以直接搬:

1. `session.requestHeader()?.config` 拿会话路由与参数,**包 try/catch**(新会话可能还没有请求头);
2. 没有会话路由时用 `agentDefaultModel.currentSelection()` 兜底;
3. 对"模型目录查询"类调用(`resolveModelInfo`)一律加超时;
4. 消费流按 `text-delta` / `reasoning-delta` 增量聚合;
5. 思考型模型永远准备降级链,把"空输出"当作一等公民处理;
6. 配置哲学:默认跟随,显式项只作偏离——README 的示例就是你的设计宣言。

---

*相关提交:[v1.2.0](https://github.com/zycFrancis/dsh-prompt-suggestion/releases/tag/v1.2.0) · 完整调试时间线见 [CHANGELOG](../CHANGELOG.md)*

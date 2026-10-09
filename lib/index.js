/**
 * dsh-prompt-suggestion — Host 半。
 *
 * 职责:
 *  1. 监听会话事件:`turn/end` 后延迟预生成下一条输入建议;`user/message`
 *     或运行开始时使缓存失效并中止进行中的生成(用户已亲自行动,建议过期)。
 *  2. 用 `ctx.llm.stream` 做一次小请求(不进会话日志、不带工具),按最近
 *     N 轮 user/assistant 文本生成一条简短建议。
 *  3. 提供 `promptSuggestion` 服务(手写 typertRemote 绑定,配合 ./typert
 *     清单走 Typert 网关),客户端经 `remote.promptSuggestion.*` 读取。
 *
 * 不导入 cordis/dsh-* 运行时包中的 Service/Context 类:仅用 ctx API 与
 * Node 内建模块,避免与宿主形成双实例。zod 仅用于 ./typert 清单的 codec。
 */

import s from '@deepseek-ai/schemastery'
import { appendFileSync } from 'node:fs'

/** 服务名,同时是 Client 侧 Remote 命名空间(remote.promptSuggestion)。 */
const SERVICE_KEY = 'promptSuggestion'
const PACKAGE = 'dsh-prompt-suggestion'

/** 单个会话的建议缓存条目。state: pending | ready | failed。 */
function pendingEntry(turnEndSeq) {
  return { state: 'pending', text: '', turnEndSeq }
}

/**
 * 从会话事件倒序收集最近若干轮 user/assistant 文本,拼成生成输入。
 * 只读快照,不触碰 surface 投影;tool 结果与系统消息不进入建议上下文。
 * @param {import('@deepseek-ai/dsh-session').Session} session - 会话。
 * @param {number} maxTurns - 最多回溯的回合数。
 * @param {number} maxChars - 拼接文本的字符上限。
 * @returns {{ lines: Array<{ role: 'user' | 'assistant', text: string }>, lastAssistantText: string, turnEndSeq: number } | null}
 */
function collectConversation(session, maxTurns, maxChars) {
  const events = session.snapshotEvents()
  // turnEndSeq:触发本次生成的 turn/end 事件 seq;无 turn/end(如手动拉取)时用日志末位。
  let turnEndSeq = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') { turnEndSeq = events[i].seq; break }
  }
  if (turnEndSeq < 0) return events.length > 0 ? { lines: [], lastAssistantText: '', turnEndSeq: events.at(-1).seq } : null

  const lines = []
  let chars = 0
  let turnsSeen = 0
  let lastAssistantText = ''
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.seq > turnEndSeq) continue
    if (event.type === 'turn/end') {
      turnsSeen++
      if (turnsSeen > maxTurns) break
      continue
    }
    let role = null
    let text = ''
    if (event.type === 'user/message') {
      role = 'user'
      text = messageText(event.data)
    } else if (event.type === 'assistant/message') {
      role = 'assistant'
      text = messageText(event.data?.message)
    }
    if (role === null || text === '') continue
    if (role === 'assistant' && lastAssistantText === '') lastAssistantText = text
    // 单条消息过长时保头截断,保留开头信息量。
    const clipped = text.length > 2000 ? `${text.slice(0, 2000)}…` : text
    if (chars + clipped.length > maxChars) {
      const remain = maxChars - chars
      if (remain > 200) lines.push({ role, text: `${clipped.slice(0, remain)}…` })
      break
    }
    chars += clipped.length
    lines.push({ role, text: clipped })
  }
  if (lines.length === 0) return null
  return { lines: lines.reverse(), lastAssistantText, turnEndSeq }
}

/** 提取一条消息里的纯文本(text 块拼接,忽略图片/文件等)。 */
function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 清洗模型输出:去包裹引号/代码围栏/思考引导词,压平换行,截断长度。 */
function normalizeSuggestion(raw, maxChars) {
  let text = String(raw ?? '')
  // 去代码围栏 ```…``` / `…`。
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/u, '$1')
  text = text.replace(/^`(.*)`$/u, '$1')
  // 去首尾成对引号(中英文)。
  text = text.replace(/^["'“”『』「」]+|["'“”『』「」]+$/gu, '')
  // 去思考流兜底常见的引导前缀(中英文冒号均覆盖)。
  text = text.replace(/^(?:最终答案|答案|结论|建议|next prompt|suggestion|answer)\s*[:：]\s*/iu, '')
  // 建议是单行输入:压平内部换行。
  text = text.replace(/\s*\n+\s*/gu, ' ').trim()
  if (text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()}…`
  return text
}

/** 系统指令:语言跟随对话、单行、只输出建议本身。 */
function systemInstruction() {
  return [
    'You suggest the user\'s NEXT prompt for an AI coding-assistant chat.',
    'Read the recent conversation and propose one concrete, useful follow-up action the user would likely type next.',
    'Rules:',
    '- Reply with the prompt text ONLY: one line, no quotes, no Markdown, no explanation, no prefix like "Next:".',
    '- Use the SAME natural language as the conversation (Chinese conversation → Chinese suggestion).',
    '- Keep it under 12 words (CJK: under 30 characters). Prefer specific actions (e.g. "跑一下测试并修复失败的用例", "commit these changes").',
    '- If the last assistant message ends with a question, suggest a short answer or the most likely choice.',
    '- Never suggest meta actions like "continue" alone unless nothing else fits.',
  ].join('\n')
}

/** 把收集的对话行框成 JSON,用户文本不能破坏结构分隔符。 */
function frameInput(lines) {
  return `Recent conversation (oldest first):\n${JSON.stringify(lines)}\n\nSuggest the user's next prompt.`
}

/**
 * 解析模型路由:显式配置 > 会话最近一次请求路由 > 全局默认模型。
 * @param {object} config - 插件配置。
 * @param {import('@deepseek-ai/dsh-session').Session} session - 会话。
 * @param {unknown} agentDefaultModel - 可选的默认模型服务。
 * @returns {{ provider: string, model: string } | null}
 */
function resolveRoute(config, session, agentDefaultModel) {
  if (typeof config.provider === 'string' && config.provider !== ''
    && typeof config.model === 'string' && config.model !== '') {
    return { provider: config.provider, model: config.model }
  }
  try {
    const header = session.requestHeader?.()
    const route = header?.config
    if (typeof route?.provider === 'string' && typeof route?.model === 'string') {
      return { provider: route.provider, model: route.model }
    }
  } catch { /* 会话无请求头时忽略 */ }
  try {
    const selection = agentDefaultModel?.currentSelection?.()
    if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch { /* 默认模型服务不可用时忽略 */ }
  return null
}

/**
 * 解析模型的最低推理档:思考型模型(GLM 等)不降档时,几十 token 的
 * 输出上限会被思考内容耗尽(max-tokens 截断,正文为空)。
 * 带 5s 超时:模型信息解析挂起(适配器网络卡死)时不能阻塞整条生成链。
 * @param {object} llm - llm 服务。
 * @param {{ provider: string, model: string }} route - 路由。
 * @param {AbortSignal} [signal] - 调用方的取消信号。
 * @returns {Promise<string | undefined>} effort id;无推理能力、不支持或超时时 undefined。
 */
async function lowestReasoningEffort(llm, route, signal) {
  let info
  try {
    info = await Promise.race([
      llm.resolveModelInfo(route.provider, route.model, signal),
      new Promise((resolve) => setTimeout(resolve, 5000, undefined)),
    ])
  } catch { /* 模型信息不可用时按无 effort 裸调 */ }
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  // 优先显式"关闭/最低"语义,其次信任 adapter 的低→高排序取第一个。
  const off = efforts.find((effort) => /^(disable|disabled|none|off|minimal|lowest)$/i.test(effort.id))
  if (off !== undefined) return off.id
  const low = efforts.find((effort) => /^low(est)?$/i.test(effort.id))
  return low?.id ?? efforts[0]?.id
}

/**
 * 从思考流尾部提取结论段:取最后一非空段,超长时保尾(结论在末尾)。
 * @param {string} reasoning - 思考全文。
 * @returns {string} 候选文本;思考为空返回空串。
 */
function tailOfReasoning(reasoning) {
  const trimmed = reasoning.trim()
  if (trimmed === '') return ''
  // 段落/换行切分,倒序找第一段有实义的内容。
  const parts = trimmed.split(/\n{2,}|\n/).map((part) => part.trim()).filter((part) => part !== '')
  const tail = parts.at(-1) ?? trimmed
  return tail.length > 240 ? tail.slice(-240) : tail
}

/**
 * 消费 llm.stream 并聚合文本;缺 finish 或 finish 非 stop 一律判失败。
 * 思考型模型正文可能为空而结论留在思考流里,两者都收集。
 * @param {object} llm - llm 服务。
 * @param {object} options - GenerateOptions。
 * @returns {Promise<{ text: string, reasoning: string }>} 正文与思考全文;失败抛错。
 */
async function streamText(llm, options) {
  let out = ''
  let reasoning = ''
  let finish = null
  for await (const chunk of llm.stream(options)) {
    if (chunk === null || chunk === undefined) continue
    if (chunk.type === 'text' && typeof chunk.text === 'string') out += chunk.text
    else if (chunk.type === 'reasoning' && typeof chunk.text === 'string') reasoning += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish === null || finish.kind !== 'stop') {
    const detail = finish?.failure?.message ?? (finish === null ? 'missing finish' : finish.kind)
    throw new Error(`suggestion stream finished: ${String(detail)}`)
  }
  return { text: out, reasoning }
}

/**
 * 创建 promptSuggestion 服务对象。
 * @param {object} ctx - 宿主插件上下文。
 * @param {object} deps - { llm, agentDefaultModel, config }。
 * @returns {object} 服务(带 typertRemote 绑定)。
 */
function createService(ctx, deps) {
  /** @type {Map<string, { state: string, text: string, turnEndSeq: number }>} */
  const cache = new Map()
  /** @type {Map<string, { abort: AbortController, timer: unknown }>} 进行中的生成与预生成定时器。 */
  const inflight = new Map()

  const configOf = () => deps.config ?? {}
  const enabled = () => configOf().enabled !== false

  /** 取消进行中的生成并清理定时器。 */
  const cancelGeneration = (sessionId) => {
    const task = inflight.get(sessionId)
    if (task === undefined) return
    if (task.timer !== null && task.timer !== undefined) clearTimeout(task.timer)
    task.abort.abort()
    inflight.delete(sessionId)
  }

  /** 会话重新开始运行或收到新用户输入:建议过期。 */
  const invalidate = (sessionId, reason) => {
    logNo(ctx, `invalidate ${sessionId.slice(0, 12)} (${reason})`)
    cancelGeneration(sessionId)
    cache.delete(sessionId)
  }

  /**
   * 为一个会话生成建议(幂等:同一 turnEndSeq 已 ready 则跳过)。
   * @param {import('@deepseek-ai/dsh-session').Session} session - 会话。
   * @param {number} [delayMs] - 延迟(预生成防抖);立即生成为 0。
   */
  const generate = (session, delayMs = 0) => {
    let sessionId = 'unknown'
    try {
      sessionId = session.id
      logNo(ctx, `generate entry ${sessionId.slice(0, 12)} delay=${delayMs}`)
      if (!enabled()) return logNo(ctx, `generate skipped: disabled`)
      const cfg = {
        historyTurns: 4,
        maxInputChars: 6000,
        maxOutputTokens: 4096,
        ...configOf(),
      }
      const collected = collectConversation(session, cfg.historyTurns, cfg.maxInputChars)
      if (collected === null) return logNo(ctx, `generate skipped: no conversation (${sessionId.slice(0, 12)})`)
      // 回合里没有任何 assistant 文本(如纯工具失败)不生成。
      if (collected.lastAssistantText === '' && collected.lines.every((line) => line.role === 'user')) {
        return logNo(ctx, `generate skipped: no assistant text (${sessionId.slice(0, 12)})`)
      }
      const existing = cache.get(sessionId)
      if (existing !== undefined && existing.turnEndSeq === collected.turnEndSeq
        && (existing.state === 'ready' || (existing.state === 'pending' && inflight.has(sessionId)))) {
        return logNo(ctx, `generate skipped: idempotent (${sessionId.slice(0, 12)})`)
      }

      cancelGeneration(sessionId)
      const abort = new AbortController()
      const task = { abort, timer: null }
      inflight.set(sessionId, task)
      cache.set(sessionId, pendingEntry(collected.turnEndSeq))
      logNo(ctx, `timer set ${sessionId.slice(0, 12)} for ${delayMs}ms (turnEndSeq=${collected.turnEndSeq})`)

    const run = async () => {
      try {
        const route = resolveRoute(cfg, session, deps.agentDefaultModel)
        if (route === null) throw new Error('no model route available (configure provider/model)')
        // 日志先于模型信息解析:挂起也能看到生成已调度。
        log(ctx, `generating via ${route.provider}/${route.model} for ${sessionId.slice(0, 12)} (delay ${delayMs})`)
        // 思考型模型降到最低推理档,避免思考耗尽小输出上限。
        const effort = await lowestReasoningEffort(deps.llm, route, abort.signal)
        if (effort !== undefined) logNo(ctx, `effort=${effort} for ${route.model}`)
        const streamed = await streamText(deps.llm, {
          provider: route.provider,
          model: route.model,
          system: systemInstruction(),
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: frameInput(collected.lines) }],
            source: { kind: PACKAGE },
          }],
          maxTokens: cfg.maxOutputTokens,
          ...effort === undefined ? {} : { reasoningEffort: effort },
          sessionId,
          purpose: 'prompt-suggestion',
          signal: abort.signal,
        })
        // 思考型模型正文为空时,取思考流的末段(结论通常在尾部)做候选。
        const raw = streamed.text.trim() !== '' ? streamed.text : tailOfReasoning(streamed.reasoning)
        const suggestion = normalizeSuggestion(raw, 80)
        logNo(ctx, `raw model output (${streamed.text.length} text/${streamed.reasoning.length} reasoning chars): ${JSON.stringify(streamed.text.slice(0, 160))} -> normalized: ${JSON.stringify(suggestion.slice(0, 80))}`)
        if (suggestion === '') throw new Error('model produced no usable suggestion')
        const current = cache.get(sessionId)
        if (current === undefined || current.turnEndSeq !== collected.turnEndSeq) return // 已被新回合取代
        cache.set(sessionId, { state: 'ready', text: suggestion, turnEndSeq: collected.turnEndSeq })
        log(ctx, `suggestion ready for ${sessionId}: ${suggestion.slice(0, 24)}`)
      } catch (error) {
        if (abort.signal.aborted) return
        log(ctx, `generation FAILED: ${error instanceof Error ? error.message : String(error)}`)
        const current = cache.get(sessionId)
        if (current !== undefined && current.turnEndSeq === collected.turnEndSeq) {
          cache.set(sessionId, { state: 'failed', text: '', turnEndSeq: collected.turnEndSeq })
        }
        ctx.logger?.warn?.(`[${PACKAGE}] suggestion generation failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (inflight.get(sessionId) === task) inflight.delete(sessionId)
      }
    }

    if (delayMs > 0) {
      task.timer = setTimeout(() => {
        task.timer = null
        try {
          if (abort.signal.aborted) return logNo(ctx, `timer fired but aborted (${sessionId.slice(0, 12)})`)
          void run()
        } catch (error) {
          logNo(ctx, `timer callback threw: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, delayMs)
    } else {
      void run()
    }
  } catch (error) {
    logNo(ctx, `generate threw for ${sessionId.slice(0, 12)}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
  }

  // ── 事件接线(挂在 inject 子上下文,llm 重载时随 fiber 撤回重建) ────────
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      invalidate(session.id, 'user/message')
      return
    }
    if (event.type === 'turn/end') {
      logNo(ctx, `turn/end seen for ${session.id.slice(0, 12)} (delay ${configOf().delayMs ?? 600})`)
      // 延迟预生成:给收尾事件(usage、标题等)留出时间,并天然合并连续 turn。
      generate(session, configOf().delayMs ?? 600)
    }
  })
  ctx.on('api-session/status', (sessionId, running) => {
    if (running) invalidate(sessionId, 'running')
  })
  // 会话离开注册表 / 归档移除:清理缓存与进行中的生成,避免 Map 残留。
  ctx.on('session/disposed', (session) => {
    invalidate(session.id, 'disposed')
  })
  ctx.on('api-session/removed', (sessionId) => {
    invalidate(sessionId, 'removed')
  })
  // 插件停用/重载:取消全部进行中的生成,缓存随 fiber 丢弃。
  ctx.effect(() => () => {
    for (const id of [...inflight.keys()]) cancelGeneration(id)
    cache.clear()
  }, 'prompt-suggestion: dispose generations')

  // ── RPC 面(Typert 网关按 ./typert 清单路由到这里) ─────────────────────
  const service = {
    /** 读取建议;无缓存且会话空闲时可按需触发生成。 */
    async get(sessionId) {
      log(ctx, `rpc get ${String(sessionId).slice(0, 12)}`)
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { state: 'failed', text: '' }
      }
      const entry = cache.get(sessionId)
      if (entry !== undefined) {
        return entry.state === 'ready' ? { state: 'ready', text: entry.text } : { state: entry.state, text: '' }
      }
      // 按需路径:Client 询问一个尚未预生成的会话(如安装后首个回合)。
      const session = deps.sessions?.get?.(sessionId)
      if (session === undefined) return { state: 'pending', text: '' }
      if (enabled()) generate(session, 0)
      return { state: 'pending', text: '' }
    },
    /** 用户关闭建议:本回合不再显示,同时取消尚未完成的生成。 */
    async dismiss(sessionId) {
      cancelGeneration(sessionId)
      const entry = cache.get(sessionId)
      if (entry !== undefined) cache.set(sessionId, { state: 'failed', text: '', turnEndSeq: entry.turnEndSeq })
      return { ok: true }
    },
  }

  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY },
  })
  return service
}

/** Loader 配置schema(schemastery,Cordis 标准)。用户可在 cordis.patch.yml 覆盖;运行时另有兜底默认。 */
export const Config = s.object({
  enabled: s.boolean().default(true),
  provider: s.string(),
  model: s.string(),
  historyTurns: s.number().step(1).min(1).max(20).default(4),
  maxInputChars: s.number().step(1).min(500).max(40000).default(6000),
  maxOutputTokens: s.number().step(1).min(16).max(32768).default(4096),
  delayMs: s.number().step(1).min(0).max(10000).default(600),
  debugLog: s.boolean().default(false),
})

/** 诊断日志开关:debugLog 配置为 true 时额外落 /tmp/dsh-prompt-suggestion.log。 */
let debugLogEnabled = false

/** 诊断日志(否决分支):只在 debugLog 开启时落盘。 */
function logNo(ctx, message) {
  if (!debugLogEnabled) return
  try {
    appendFileSync('/tmp/dsh-prompt-suggestion.log', `${new Date().toISOString()} [${PACKAGE}] ${message}\n`)
  } catch { /* /tmp 不可写时静默 */ }
}

/** 诊断日志:logger(不可用时 console);debugLog 开启时同步落 /tmp。 */
function log(ctx, message) {
  const line = `[${PACKAGE}] ${message}`
  if (ctx?.logger?.info !== undefined) ctx.logger.info(line)
  else console.log(line)
  logNo(ctx, message)
}

/** 挂载 Host 半:llm 为可选依赖,缺失时保持惰性;服务生命周期跟随 inject fiber。 */
export function apply(ctx, config = {}) {
  debugLogEnabled = config.debugLog === true
  log(ctx, 'host half apply()')
  ctx.inject(['llm'], (llmCtx) => {
    const llm = llmCtx.llm
    const agentDefaultModel = llmCtx.get('agentDefaultModel')
    const sessions = llmCtx.get('sessions')
    // provide 与事件监听都挂 llmCtx:llm 重载时随 fiber 撤回,避免双份监听。
    llmCtx.provide(SERVICE_KEY, createService(llmCtx, { llm, agentDefaultModel, sessions, config }))
    log(llmCtx, 'service provided')
  })
}

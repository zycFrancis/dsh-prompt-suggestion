/**
 * Host 半逻辑单元测试(纯 mock,不依赖运行中的 Harness)。
 * 运行:node --test test/unit.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { plugin } from './helpers.mjs'

/** 构造一个宿主 ctx mock:外层 ctx + inject 子上下文(llmCtx)。 */
function makeHarness({ llm }) {
  const handlers = new Map()
  const provided = []
  const llmCtx = {
    llm,
    get: () => undefined,
    on: (name, fn) => { handlers.set(name, fn); return () => {} },
    provide: (name, value) => { provided.push([name, value]) },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
  }
  const ctx = {
    on: (name, fn) => { handlers.set(`root:${name}`, fn); return () => {} },
    effect: (fn) => { fn(); return () => {} },
    inject: (deps, fn) => {
      assert.deepEqual(deps, ['llm'])
      return fn(llmCtx)
    },
  }
  return { ctx, handlers, provided, service: () => provided[0]?.[1] }
}

const fakeLlm = (chunks) => ({
  stream: async function* () { for (const chunk of chunks) yield chunk },
})

const okLlm = fakeLlm([
  { type: 'text-delta', text: '"跑' },
  { type: 'text-delta', text: '一下测试"' },
  { type: 'finish', reason: { kind: 'stop' } },
])

test('Config schema accepts defaults and rejects bad types', async () => {
  const { Config } = await import('../lib/index.js')
  const parsed = Config({})
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.historyTurns, 4)
  assert.equal(parsed.maxOutputTokens, 4096)
  assert.equal(parsed.delayMs, 600)
  assert.throws(() => Config({ historyTurns: 0 }))
  assert.throws(() => Config({ enabled: 'yes' }))
  const explicit = Config({ enabled: false, provider: 'deepseek', model: 'x' })
  assert.equal(explicit.enabled, false)
})

test('apply() wires service on the inject context with typertRemote binding', async () => {
  const h = makeHarness({ llm: okLlm })
  plugin.apply(h.ctx, {})
  assert.equal(h.provided.length, 1)
  assert.equal(h.provided[0][0], 'promptSuggestion')
  const service = h.service()
  assert.equal(typeof service.get, 'function')
  assert.equal(typeof service.dismiss, 'function')
  const binding = service.typertRemote
  assert.equal(binding.service, service)
  assert.equal(binding.serviceKey, 'promptSuggestion')
  assert.equal(binding.namespace, 'promptSuggestion')
  const dismissed = await service.dismiss('sess-1')
  assert.deepEqual(dismissed, { ok: true })
})

test('get() with empty/unknown session never throws', async () => {
  const h = makeHarness({ llm: okLlm })
  plugin.apply(h.ctx, {})
  const service = h.service()
  const bad = await service.get('')
  assert.equal(bad.state, 'failed')
  const unknown = await service.get('sess-none')
  assert.ok(unknown.state === 'pending' || unknown.state === 'failed')
})

test('lifecycle: turn/end generates, user/message and running invalidate', async () => {
  const h = makeHarness({ llm: okLlm })
  plugin.apply(h.ctx, { delayMs: 0 })
  const service = h.service()
  const sessionEvent = h.handlers.get('session/event')
  const statusEvent = h.handlers.get('api-session/status')
  assert.ok(sessionEvent !== undefined && statusEvent !== undefined)

  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: '帮我写个插件' }] } },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: '已完成实现' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'stop' } } },
  ]
  const session = {
    id: 'sess-a',
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
  }
  for (const event of events) sessionEvent(session, event)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const got = await service.get('sess-a')
  assert.equal(got.state, 'ready')
  assert.equal(got.text, '跑一下测试')

  sessionEvent(session, { type: 'user/message', seq: 4, data: { role: 'user', content: [{ type: 'text', text: '好' }] } })
  assert.notEqual((await service.get('sess-a')).state, 'ready')

  statusEvent('sess-a', true)
  assert.notEqual((await service.get('sess-a')).state, 'ready')
})

test('llm failure yields failed state, never throws to RPC', async () => {
  const h = makeHarness({
    llm: fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]),
  })
  plugin.apply(h.ctx, { delayMs: 0 })
  const service = h.service()
  const sessionEvent = h.handlers.get('session/event')
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'stop' } } },
  ]
  const session = {
    id: 'sess-b',
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  for (const event of events) sessionEvent(session, event)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const got = await service.get('sess-b')
  assert.equal(got.state, 'failed')
  assert.equal(got.text, '')
})

test('reasoning fallback: tailOfReasoning extracts conclusion', async () => {
  // 模块未导出内部函数;经由行为验证:text 空时,reasoning 尾段成为建议来源。
  const mod = await import('../lib/index.js')
  const h = makeHarness({
    llm: fakeLlm([
      { type: 'reasoning-delta', text: '先想想…\n再想想…\n最终答案:运行测试并修复' },
      { type: 'text-delta', text: '' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
  })
  mod.apply(h.ctx, { delayMs: 0 })
  const service = h.service()
  const sessionEvent = h.handlers.get('session/event')
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'stop' } } },
  ]
  const session = {
    id: 'sess-c',
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  for (const event of events) sessionEvent(session, event)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const got = await service.get('sess-c')
  assert.equal(got.state, 'ready')
  assert.ok(got.text.includes('运行测试'), `text derived from reasoning tail: ${got.text}`)
})

test('suggestion request follows the session route including reasoning effort', async () => {
  const seen = []
  const llm = {
    stream: async function* (options) {
      seen.push(options)
      yield { type: 'text-delta', text: '跑测试' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
  }
  const h = makeHarness({ llm })
  const mod = await import('../lib/index.js')
  mod.apply(h.ctx, { delayMs: 0 })
  const sessionEvent = h.handlers.get('session/event')
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'stop' } } },
  ]
  const session = {
    id: 'sess-effort',
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
  }
  for (const event of events) sessionEvent(session, event)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(seen.length >= 1, 'suggestion request issued')
  assert.equal(seen[0].reasoningEffort, 'high', 'session effort is passed through')
  assert.equal(seen[0].provider, 'p')
  assert.equal(seen[0].model, 'm')
})

test('without session effort the lowest model effort is used', async () => {
  const seen = []
  const llm = {
    stream: async function* (options) {
      seen.push(options)
      yield { type: 'text-delta', text: '跑测试' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }),
  }
  const h = makeHarness({ llm })
  const mod = await import('../lib/index.js')
  mod.apply(h.ctx, { delayMs: 0 })
  const sessionEvent = h.handlers.get('session/event')
  const events = [
    { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'stop' } } },
  ]
  const session = {
    id: 'sess-noeffort',
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  for (const event of events) sessionEvent(session, event)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(seen.length >= 1)
  assert.equal(seen[0].reasoningEffort, 'low', 'lowest effort resolved when session has none')
})

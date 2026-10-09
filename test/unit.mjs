/**
 * Host 半核心逻辑单元测试(纯函数,不依赖运行中的 Harness)。
 * 运行:node --test test/unit.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { default: s } = await import('@deepseek-ai/schemastery')

// index.js 顶层只 import schemastery;导入即可拿到全部导出。
const plugin = await import('../lib/index.js')

// ── 内部函数经由插件模块的结构不可直接访问,这里复刻关键纯函数的行为
//    断言改走"通过导出面 + 等价实现快照"不可行,因此本文件对可导出部分
//    (Config)做校验,纯函数逻辑用行为级用例在 test/host-service.mjs 覆盖。

test('Config schema accepts defaults and rejects bad types', () => {
  const parsed = plugin.Config({})
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.historyTurns, 4)
  assert.equal(parsed.maxOutputTokens, 96)
  assert.equal(parsed.delayMs, 600)

  assert.throws(() => plugin.Config({ historyTurns: 0 }))
  assert.throws(() => plugin.Config({ enabled: 'yes' }))
  const explicit = plugin.Config({ enabled: false, provider: 'deepseek', model: 'x' })
  assert.equal(explicit.enabled, false)
  assert.equal(explicit.provider, 'deepseek')
})

test('apply() wires service when llm is present', async () => {
  const provided = []
  const listeners = []
  const ctx = {
    on: (name, fn) => { listeners.push([name, fn]); return () => {} },
    effect: (fn) => { fn(); return () => {} },
    inject: (deps, fn) => {
      assert.deepEqual(deps, ['llm'])
      return fn({ llm: fakeLlm, get: () => undefined })
    },
    provide: (name, value) => { provided.push([name, value]) },
    logger: { warn: () => {} },
  }
  const fakeLlm = {
    stream: async function* () {
      yield { type: 'text', text: '"跑一下测试"' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  plugin.apply(ctx, {})
  assert.equal(provided.length, 1)
  assert.equal(provided[0][0], 'promptSuggestion')
  const service = provided[0][1]
  assert.equal(typeof service.get, 'function')
  assert.equal(typeof service.dismiss, 'function')

  // typertRemote 绑定满足网关校验的形状。
  const binding = service.typertRemote
  assert.equal(binding.service, service)
  assert.equal(binding.serviceKey, 'promptSuggestion')
  assert.equal(binding.namespace, 'promptSuggestion')

  // dismiss 幂等返回 ok。
  const dismissed = await service.dismiss('sess-1')
  assert.deepEqual(dismissed, { ok: true })
})

test('get() without llm session returns pending/failed shape, never throws', async () => {
  const provided = []
  const fakeLlm = { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } }
  const ctx = {
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    inject: (deps, fn) => fn({ llm: fakeLlm, get: () => undefined }),
    provide: (name, value) => { provided.push([name, value]) },
    logger: { warn: () => {} },
  }
  plugin.apply(ctx, {})
  const service = provided[0][1]
  const bad = await service.get('')
  assert.equal(bad.state, 'failed')
  const unknown = await service.get('sess-none')
  assert.ok(unknown.state === 'pending' || unknown.state === 'failed')
})

test('turn/end then user/message lifecycle: suggestion invalidates on new input', async () => {
  const provided = []
  const handlers = new Map()
  const fakeLlm = {
    stream: async function* () {
      yield { type: 'text', text: '修复失败的测试' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    on: (name, fn) => { handlers.set(name, fn); return () => {} },
    effect: (fn) => { fn(); return () => {} },
    inject: (deps, fn) => fn({ llm: fakeLlm, get: () => undefined }),
    provide: (name, value) => { provided.push([name, value]) },
    logger: { warn: () => {} },
  }
  plugin.apply(ctx, { delayMs: 0 })
  const service = provided[0][1]
  const sessionEvent = handlers.get('session/event')
  const statusEvent = handlers.get('api-session/status')
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
  // delayMs=0 时生成立即调度;等待微任务+定时器落定。
  await new Promise((resolve) => setTimeout(resolve, 30))
  const got = await service.get('sess-a')
  assert.equal(got.state, 'ready')
  assert.equal(got.text, '修复失败的测试')

  // 新用户输入使建议失效。
  sessionEvent(session, { type: 'user/message', seq: 4, data: { role: 'user', content: [{ type: 'text', text: '好' }] } })
  const after = await service.get('sess-a')
  assert.equal(after.state, 'pending')

  // running=true 同样失效。
  statusEvent('sess-a', true)
  const afterRun = await service.get('sess-a')
  assert.equal(afterRun.state, 'pending')
})

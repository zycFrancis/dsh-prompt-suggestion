/**
 * Typert 清单合规测试:直接用宿主同款校验器(typert-loader 的
 * validateTypertManifest)检查 ./typert 导出,防止形状回归。
 * 运行:node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { TYPERT } from '../lib/typert.host.js'

test('typert manifest passes the loader validation', () => {
  // 校验失败会直接抛错;能返回即注册成功。
  const manifest = validateTypertManifest('dsh-prompt-suggestion', TYPERT)
  assert.equal(manifest, TYPERT)
  // 端点覆盖:get/dismiss 均以 strict codec 声明。
  const endpoints = TYPERT.invocations.map((invocation) => `${invocation.namespace}/${invocation.method}`)
  assert.deepEqual([...endpoints].sort(), ['promptSuggestion/dismiss', 'promptSuggestion/get'])
  for (const invocation of TYPERT.invocations) {
    assert.equal(invocation.result.mode, 'strict')
    assert.equal(typeof invocation.result.create, 'function')
    for (const parameter of invocation.parameters) {
      assert.equal(parameter.codec.mode, 'strict')
      assert.equal(typeof parameter.codec.create, 'function')
    }
  }
  // create() 工厂产出可用的 zod 实例。
  const sample = TYPERT.invocations[0].result.create().parse({ state: 'ready', text: 'x' })
  assert.equal(sample.state, 'ready')
})

test('client CONTRIBUTION codecs satisfy the strict shape', async () => {
  // 从 client 模块源码中提取 CONTRIBUTION 结构(factory 不执行浏览器代码)。
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  const idMatch = source.match(/const CONTRIBUTION = \{[\s\S]*?\n    \}/)
  assert.ok(idMatch !== null, 'CONTRIBUTION literal found')
  assert.ok(source.includes('mode: \'strict\''), 'strict mode present')
  assert.ok(!source.includes('codecOf'), 'duck-typed codecOf helper gone')
})

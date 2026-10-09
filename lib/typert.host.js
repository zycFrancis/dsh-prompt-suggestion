/**
 * dsh-prompt-suggestion 的 Host 面 Typert 清单(由 typert-loader 自动扫描注册)。
 * 手写清单,结构与 @deepseek-ai/dsh-typert-generator 产物一致:
 * `./typert` 导出 TYPERT,invocations 的 codec 必须是 zod v4 实例。
 */

import { z } from 'zod'

const sessionIdCodec = z.string()

const suggestionCodec = z.object({
  state: z.enum(['pending', 'ready', 'failed']),
  text: z.string(),
})

const dismissCodec = z.object({ ok: z.boolean() })

export const TYPERT = {
  package: 'dsh-prompt-suggestion',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-prompt-suggestion#promptSuggestion/get',
      service: 'promptSuggestion',
      namespace: 'promptSuggestion',
      method: 'get',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec },
      ],
      result: suggestionCodec,
    },
    {
      id: 'dsh-prompt-suggestion#promptSuggestion/dismiss',
      service: 'promptSuggestion',
      namespace: 'promptSuggestion',
      method: 'dismiss',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec },
      ],
      result: dismissCodec,
    },
  ],
}

export default TYPERT

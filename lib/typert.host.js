/**
 * dsh-prompt-suggestion 的 Host 面 Typert 清单(由 typert-loader 自动扫描注册)。
 * 形状对齐 @deepseek-ai/dsh-typert-generator 产物:
 *  - 必须有 `model`(loader 的 validateTypertManifest 要求);
 *  - codec 必须是 `{ mode:'strict', typeSymbol, create }` 惰性工厂,create 返回 zod 实例。
 */

import { z } from 'zod'

const sessionIdCodec = () => z.string()

const suggestionCodec = () => z.object({
  state: z.enum(['pending', 'ready', 'failed']),
  text: z.string(),
})

const dismissCodec = () => z.object({ ok: z.boolean() })

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
        {
          name: 'sessionId',
          wire: 'sessionId',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-prompt-suggestion#promptSuggestion/get:sessionId',
            create: sessionIdCodec,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-prompt-suggestion#promptSuggestion/get:result',
        create: suggestionCodec,
      },
    },
    {
      id: 'dsh-prompt-suggestion#promptSuggestion/dismiss',
      service: 'promptSuggestion',
      namespace: 'promptSuggestion',
      method: 'dismiss',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'sessionId',
          wire: 'sessionId',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-prompt-suggestion#promptSuggestion/dismiss:sessionId',
            create: sessionIdCodec,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-prompt-suggestion#promptSuggestion/dismiss:result',
        create: dismissCodec,
      },
    },
  ],
  model: {
    services: [
      {
        tags: [],
        description: 'Per-session next-prompt suggestions generated after each turn; read and dismissed over Typert RPC.',
        summary: 'Per-session next-prompt suggestions generated after each turn.',
        key: 'promptSuggestion',
        exportName: 'promptSuggestion',
        members: [
          {
            kind: 'method',
            name: 'get',
            signature: 'async get(sessionId: string): Promise<{ state: "pending" | "ready" | "failed", text: string }>',
            summary: 'Read one session\'s suggestion; triggers on-demand generation when idle and unseen.',
          },
          {
            kind: 'method',
            name: 'dismiss',
            signature: 'async dismiss(sessionId: string): Promise<{ ok: boolean }>',
            summary: 'Drop one session\'s suggestion for the current turn.',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT

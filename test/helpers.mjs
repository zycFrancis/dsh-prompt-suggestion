/**
 * 测试共享:一次性导入插件模块(schemastery 依赖经 node_modules 解析)。
 * index.js 顶层只 import schemastery,可安全重复导入(模块缓存)。
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
export const { plugin } = { plugin: await import('../lib/index.js') }
export { require }

/**
 * dsh-prompt-suggestion — Client 半。
 *
 * 职责:
 *  1. `$mount` promptSuggestion Remote 命名空间(与服务端 ./typert 清单对应,
 *     codec 形状与 typert-generator 产物一致:{mode:'strict',typeSymbol,create})。
 *  2. 在 `conversation.input.overlay` 注册 GhostSuggestion:回合结束
 *     (running→false)时从 Host 拉取建议(输入非空时拉取结果不展示),
 *     以灰色 ghost text 叠加在 composer 编辑器内(对齐宿主 placeholder 的
 *     定位),Tab 采纳、Esc 关闭、任何输入使其消失。
 *
 * DOM 约定:ghost 通过 React portal 渲染进宿主编辑器容器
 * `[data-input-scroll]` 的首个子元素(position:relative 的 .grow),
 * 复用 placeholder 的 inset(4px 8px auto 14px)对齐输入文本;
 * ghost 可见时用 `:has()` 隐藏宿主 placeholder,避免双行文字重叠。
 * 这些是宿主已发布多年的稳定 data 属性,不改写宿主 DOM。
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-suggestion',
  factory(require) {
    // 加载自诊断:DevTools console 可直接确认本模块是否进入页面。
    console.log('[dsh-prompt-suggestion] client module loaded')
    const React = require('react')
    const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const Fragment = React.Fragment

    const NS = 'dsh-prompt-suggestion'
    const SLOT = 'conversation.input.overlay'

    // ── RPC 贡献(与服务端 ./typert 清单一一对应) ─────────────────────────

    const parseSuggestion = (v) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return { state: 'failed', text: '' }
      const state = v.state === 'ready' || v.state === 'pending' ? v.state : 'failed'
      return { state, text: typeof v.text === 'string' ? v.text : '' }
    }
    // 浏览器侧拿不到 zod:create 返回带 parse 的鸭子 codec 即满足形状校验;
    // result.decode 让框架在返回路径上直接完成宽松解码。
    const sessionIdCodec = () => ({ parse: (v) => v })
    const passthroughCodec = () => ({ parse: (v) => v })
    const parseSuggestionCodec = () => ({ parse: parseSuggestion })

    const CONTRIBUTION = {
      package: NS,
      descriptors: [
        {
          id: 'dsh-prompt-suggestion#promptSuggestion/get', service: 'promptSuggestion', namespace: 'promptSuggestion', method: 'get',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'sessionId', wire: 'sessionId', source: 'json',
            codec: { mode: 'strict', typeSymbol: 'dsh-prompt-suggestion#promptSuggestion/get:sessionId', create: sessionIdCodec },
          }],
          result: {
            mode: 'strict', typeSymbol: 'dsh-prompt-suggestion#promptSuggestion/get:result',
            create: parseSuggestionCodec, decode: parseSuggestion,
          },
        },
        {
          id: 'dsh-prompt-suggestion#promptSuggestion/dismiss', service: 'promptSuggestion', namespace: 'promptSuggestion', method: 'dismiss',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'sessionId', wire: 'sessionId', source: 'json',
            codec: { mode: 'strict', typeSymbol: 'dsh-prompt-suggestion#promptSuggestion/dismiss:sessionId', create: sessionIdCodec },
          }],
          result: {
            mode: 'strict', typeSymbol: 'dsh-prompt-suggestion#promptSuggestion/dismiss:result',
            create: passthroughCodec,
          },
        },
      ],
    }

    // ── 样式(仅主题 token;ghost 对齐宿主 placeholder 的 inset) ──────────

    const CSS = `
.${NS}-ghost {
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family);
  font-size: inherit;
  line-height: inherit;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  position: absolute;
  inset: 4px 8px auto 14px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.${NS}-ghostText {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.${NS}-tabHint {
  flex: none;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 16px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xs);
  padding: 0 4px;
  background: var(--dsw-alias-interactive-bg-hover);
}
/* ghost 可见时隐藏宿主 placeholder,避免重叠(选择器锚定宿主稳定的编辑器容器结构)。 */
[data-input-scroll] > div:has(> .${NS}-ghost) [data-composer-placeholder] { visibility: hidden; }
`

    /** 在 composer 卡片内定位编辑器 grow 容器(宿主稳定 data 属性)。 */
    const findGrowContainer = (anchorEl) => {
      const card = anchorEl?.closest('[data-composer-card]')
      if (card === null || card === undefined) return null
      return card.querySelector('[data-input-scroll] > div') ?? null
    }

    // ── GhostSuggestion(session 作用域 overlay 组件) ─────────────────────

    /**
     * ghost 建议组件。
     * @param props - 标准注入 props:sessionId、useInput、inputActions、
     *   useSessionStatus(root hook,Map<sessionId,status>);__rpc 为插件注入。
     */
    function GhostSuggestion(props) {
      const { sessionId, useInput, inputActions, useSessionStatus } = props
      const input = useInput((s) => s)
      const statusMap = useSessionStatus((m) => m)
      const running = statusMap?.get?.(sessionId)?.running ?? false
      const draft = input?.draft ?? ''
      const phase = input?.phase

      // ghost 状态:null 不显示;{ text } 显示。
      const [ghost, setGhost] = useState(null)
      // 本回合已 dismiss(Esc)后不再拉取。
      const dismissedRef = useRef(false)
      // 轮询代际:新一轮拉取使旧轮询失效。
      const pollEpochRef = useRef(0)
      // 最新 draft 的镜像:异步回调落地前再核对一次,避免叠在非空输入上。
      const draftRef = useRef('')
      draftRef.current = draft
      const anchorRef = useRef(null)
      const [portalTarget, setPortalTarget] = useState(null)

      const rpc = props.__rpc

      const clearGhost = useCallback(() => {
        pollEpochRef.current++
        setGhost(null)
      }, [])

      // ── 会话切换 → 立即清空(组件实例可能被复用,防止旧 ghost 残留) ─────
      useEffect(() => {
        dismissedRef.current = false
        clearGhost()
      }, [sessionId, clearGhost])

      // ── portal 目标(编辑器 grow 容器)发现与失连重查 ───────────────────
      useLayoutEffect(() => {
        if (anchorRef.current === null) return
        const el = findGrowContainer(anchorRef.current)
        setPortalTarget(el ?? false)
        if (el === null) {
          // 宿主结构变化时稍后重试一次,避免竞态下永久失明。
          const t = setTimeout(() => setPortalTarget(findGrowContainer(anchorRef.current) ?? false), 800)
          return () => clearTimeout(t)
        }
      }, [])

      // ── 回合结束 → 拉取建议(pending 时短轮询;输入非空不落地) ──────────
      useEffect(() => {
        if (running || sessionId === undefined || rpc === null) return
        if (dismissedRef.current) return
        const epoch = ++pollEpochRef.current
        let cancelled = false
        let timer = null
        const attempt = async (tries) => {
          if (cancelled || epoch !== pollEpochRef.current) return
          let result = null
          try {
            result = await rpc.get(sessionId)
          } catch { /* 载体异常按失败重试 */ }
          if (cancelled || epoch !== pollEpochRef.current) return
          if (result === null || result.ok !== true) {
            // RPC 失败(网络闪断等)重试,不放弃本回合。
            if (tries > 0) timer = setTimeout(() => attempt(tries - 1), 1500)
            return
          }
          const value = parseSuggestion(result.value)
          if (value.state === 'ready' && value.text !== '') {
            // 拉取期间用户可能已开始输入:只在输入仍为空时落地。
            if (draftRef.current.trim() === '') setGhost({ text: value.text })
            return
          }
          if (value.state === 'pending' && tries > 0) {
            timer = setTimeout(() => attempt(tries - 1), 1500)
          }
        }
        // 稍等半秒:Host 的延迟预生成(delayMs)通常在此窗口内完成。
        timer = setTimeout(() => attempt(4), 400)
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [running, sessionId, rpc])

      // ── 开始运行/输入非空/提交中 → 隐藏 ────────────────────────────────
      useEffect(() => {
        if (running || draft.trim() !== '' || phase === 'adjudicating' || phase === 'submitting') {
          dismissedRef.current = false
          clearGhost()
        }
      }, [running, draft, phase, clearGhost])

      // ── Tab 采纳 / Esc 关闭(capture,先于 Lexical keymap) ─────────────
      useEffect(() => {
        if (ghost === null) return undefined
        const onKeyDown = (event) => {
          if (event.isComposing || event.keyCode === 229) return
          const target = event.target
          if (!(target instanceof Element)) return
          const editable = target.closest('[contenteditable="true"]')
          if (editable === null) return
          const card = editable.closest('[data-composer-card]')
          // 焦点在宿主之外的其它可编辑区时不接管 Tab/Esc。
          if (card === null) return
          // 命令菜单(@ / / 候选)打开时让位:它们自己也消费 Tab。
          if (card.querySelector('[data-trigger-menu]') !== null) return
          if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (draftRef.current.trim() !== '') return
            event.preventDefault()
            event.stopImmediatePropagation()
            const text = ghost.text
            clearGhost()
            try { inputActions?.setDraft?.(text) } catch { /* setDraft 失败不影响 ghost 关闭 */ }
            editable.focus({ preventScroll: true })
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopImmediatePropagation()
            dismissedRef.current = true
            clearGhost()
            // RPC 结果由网关包装为 {ok,value|error};reject 需显式吞掉。
            Promise.resolve(rpc?.dismiss?.(sessionId)).catch(() => {})
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [ghost, inputActions, sessionId, clearGhost, rpc])

      // portal 目标被宿主替换(composer 重建)时重新定位。
      useEffect(() => {
        if (portalTarget !== null && portalTarget !== false && portalTarget !== undefined
          && portalTarget.isConnected !== true && anchorRef.current !== null) {
          setPortalTarget(findGrowContainer(anchorRef.current) ?? false)
        }
      }, [portalTarget, ghost])

      if (ghost === null || portalTarget === null || portalTarget === false || portalTarget === undefined) {
        return h('div', { ref: anchorRef, style: { display: 'none' } })
      }
      return h(Fragment, null,
        h('div', { ref: anchorRef, style: { display: 'none' } }),
        createPortal(
          h('div', {
            className: `${NS}-ghost`,
            'data-prompt-suggestion': 'ghost',
            'aria-hidden': 'true',
          },
            h('span', { className: `${NS}-ghostText` }, ghost.text),
            h('span', { className: `${NS}-tabHint` }, 'Tab')),
          portalTarget),
      )
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────

    const inject = ['remote', 'slots']

    async function apply(ctx) {
      // 插件级样式:随插件卸载移除(styles 闭包符号仅动态模块可用)。
      const styleTag = document.createElement('style')
      styleTag.dataset.plugin = NS
      styleTag.textContent = CSS
      document.head.append(styleTag)
      const removeStyle = () => styleTag.remove()

      const remote = ctx.remote
      if (remote === undefined || typeof remote.$mount !== 'function') {
        removeStyle()
        return
      }
      // $mount 失败(形状冲突、重复包名等)时不留下孤儿样式。
      let unmount
      try {
        unmount = await remote.$mount(CONTRIBUTION)
      } catch (error) {
        removeStyle()
        throw error
      }
      ctx.effect(() => () => {
        removeStyle()
        unmount()
      }, `${NS}: remote contribution`)

      const service = ctx.get('remote.promptSuggestion')
      if (service === undefined) return
      /** RPC 薄封装:网关把结果包装为 RemoteResult {ok, value|error}。 */
      const rpc = {
        get: (id) => service.get(id),
        dismiss: (id) => service.dismiss(id),
      }

      // overlay 渲染在 composer 卡片内;组件依赖 conversation 注入的
      // useInput/inputActions(session 作用域标准 props),缺失时静默不渲染,
      // 避免污染 slot entry。
      ctx.slots.inject(SLOT, () => ctx.slots.register(
        { name: SLOT, id: NS, order: 40 },
        (componentProps) => (
          typeof componentProps.useInput === 'function'
          && componentProps.inputActions !== undefined
          && typeof componentProps.useSessionStatus === 'function'
            ? h(GhostSuggestion, { ...componentProps, __rpc: rpc })
            : null
        ),
      ))
    }

    return { inject, apply }
  },
})

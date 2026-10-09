# Making Suggestions Follow the Session: Notes on One DSH Plugin's Routing Evolution

> These notes record the design process behind the model-routing mechanism in [dsh-prompt-suggestion](https://github.com/zycFrancis/dsh-prompt-suggestion) — a Claude Code-style prompt-suggestion plugin — from "follow the model, force the parameters" to "follow everything", including every pitfall along the way. Every conclusion is backed by logs or tests. If you are writing a DSH plugin that fires auxiliary LLM requests (titles, summaries, suggestions), this should save you some archaeology. (Chinese version: [routing-design-notes.md](./routing-design-notes.md))

## 1. The Problem: One Model, Two Personalities

The plugin's core action is a **standalone lightweight LLM request** fired after each turn to draft the user's next prompt. The original routing was a three-level fallback:

```
explicit config (provider/model) → session's latest request route → global default model
```

At the model level it already "followed the session" — switch to Kimi and suggestions came from Kimi. But the reasoning effort was **forced to the model's lowest tier**, for a solid reason: on thinking models the output cap is shared between reasoning and prose, and a 96-token cap is devoured by thinking before a single word of prose appears (a very real pitfall; details below).

The result was a split personality: the user chats with GLM-5.3 at high effort, while the suggestion request runs at the lowest tier — **one AI, two temperaments**. Two user comments nailed the design problem:

> "Can it stay consistent with the model I'm currently using?"

and, more fundamentally:

> "I see you put a fixed provider in the GitHub config. I don't like that approach."

The second critique targeted the README: the config section showcased `provider: deepseek` as the primary pattern, effectively encouraging users to pin the route — the opposite of the follow intuition.

## 2. The Routing Facts DSH Gives You

First, the mechanics. In a DSH session log, every model request leaves a `request/header` event whose `config` field carries the full call configuration:

```json
{
  "provider": "zai-coding-cn",
  "model": "glm-5.3-flash",
  "reasoningEffort": "high",
  "maxTokens": 131072
}
```

On the Host side, `session.requestHeader()` reads the latest such config (folded and cached). That is the authoritative source of "the model currently in use" — not the global setting, but the request this session actually just made.

Two more sources:

- `ctx.get('agentDefaultModel').currentSelection()` — the global default model (with an optional effort), a fallback only for sessions that have no request header yet;
- the plugin's own Config — explicit user override.

## 3. The New Design: Follow Everything, with Three Safety Nets

The v1.2.0 semantics collapse into one sentence: **everything follows by default; explicit config is a deviation, not a setting**.

```
Reasoning-effort resolution order:

  the session's latest effort          ← new: matches conversational behavior
    ↓ session doesn't specify one?
  the model's lowest tier (lowestReasoningEffort)
    ↓ generation comes back empty?
  retry with no effort at all
```

In code, `resolveRoute` now passes the effort through from all three sources:

```js
// session route
const route = session.requestHeader()?.config
return {
  provider: route.provider,
  model: route.model,
  ...typeof route.reasoningEffort === 'string'
    ? { reasoningEffort: route.reasoningEffort } : {},
}
```

The Config gained an optional `reasoningEffort` (joining provider/model as the "preset at initialization" surface: empty = follow, filled = override), and the README's config section was rewritten to lead with "zero-config by default".

## 4. Why the Safety Nets Are Non-Negotiable: The Pits Along the Way

"Follow the session's effort" sounds like deleting one override, but it only works because **the degradation path is robust**. Every pit below comes from real debugging logs:

**Pit 1: thinking devours the output cap.** With `maxOutputTokens: 96`, GLM-5.3 returned empty suggestions forever; the finish reason was `max-tokens` — the thinking model spent all 96 tokens on reasoning before any prose. The fix had two layers: raise the cap to 4096, and request an explicit lowest reasoning tier.

**Pit 2: the stream protocol is delta-shaped, not block-shaped.** After the cap fix, output was still 0 characters — but finish was a clean `stop`. Eventually it surfaced that `llm.stream` chunks arrive as `text-delta` / `reasoning-delta` increments, while I aggregated block-level `type: 'text'` — a match that never fires. Worse, the unit-test mocks used the same wrong shape, so an 8/8-green suite actively hid the bug. Lesson: **mocks must replicate the real protocol, not your mental model of it**. This is also why the aggregator now keeps `reasoning-delta` too — when prose is empty, the conclusion can be extracted from the tail of the thinking stream.

**Pit 3: model-info resolution hangs.** `resolveModelInfo` (which reads a model's effort list) had no timeout; once the adapter-level request hung, the whole generation chain froze forever — and exactly before the log line, so it looked like "nothing happened". It now races a 5-second timeout and falls back to calling without an effort.

Only with those three fixes in place does "session effort first" dare to be the default: even if some model's high thinking genuinely burns through 4096, the empty-output degradation chain catches it.

## 5. The Boundary of Following: Independent Request, No Cross-Contamination

"Follow everything" does not mean copying the session's request. The suggestion request keeps several deliberately independent boundaries:

- **Never enters the session log** — it is a standalone `llm.stream` call with its own `purpose` tag and emits no session events;
- **No tools** — plain text in, plain text out;
- **Independent maxTokens** — 4096 by default, not the session's 131072 (copying it is pure waste: the cap is a ceiling, not a quality knob);
- **Invalidation coupling** — the moment the session gets a new `user/message` or starts running again, the cache is dropped and any in-flight generation aborted; a stale suggestion can never appear.

## 6. How to Prove "Following" Actually Happened

Config-flavored logic is the easiest to "look right". Two verification layers:

**Cross-model evidence** (with `debugLog` on): the same plugin logs `generating via zai-coding-cn/glm-5.3` on a desktop session using GLM-5.3, and `generating via deepseek-official/deepseek-flash` on a Web instance with the default route — the code didn't change, the output changed with the session. That is following, directly observed.

**Behavioral unit tests** (no runtime required):

```js
// mock requestHeader carries reasoningEffort: 'high'
assert.equal(seen[0].reasoningEffort, 'high')  // passed through to the suggestion request
// mock without an effort
assert.equal(seen[0].reasoningEffort, 'low')   // resolved to the model's lowest tier
```

They assert on the *request parameters*, not the suggestion text — the assertion lands on the mechanism itself.

## 7. Reusing This Path

If your plugin also fires auxiliary LLM requests (titles, summaries, naming, suggestions…), this path transfers directly:

1. Read the session route and parameters from `session.requestHeader()?.config`, **wrapped in try/catch** (a fresh session may have no request header yet);
2. Fall back to `agentDefaultModel.currentSelection()` when there is no session route;
3. Put a timeout on every "model catalog" style call (`resolveModelInfo`);
4. Consume the stream by aggregating `text-delta` / `reasoning-delta` increments;
5. On thinking models, always have a degradation chain — treat "empty output" as a first-class case;
6. Config philosophy: follow by default, explicit options only as deviations — your README example *is* your design manifesto.

---

*Related release: [v1.2.0](https://github.com/zycFrancis/dsh-prompt-suggestion/releases/tag/v1.2.0) · full debugging timeline in the [CHANGELOG](../CHANGELOG.md)*

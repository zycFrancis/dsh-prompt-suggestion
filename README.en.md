# dsh-prompt-suggestion

[中文](./README.md)

Claude Code-style **prompt suggestions** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): after each turn ends, the composer shows the next suggested prompt as grey ghost text. Press **Tab** to accept it as real input (sendable with Enter), **Esc** to dismiss, or just start typing and it fades away.

```
┌──────────────────────────────────────────────┐
│  run the tests and fix failures    [Tab]     │  ← grey ghost text + Tab hint
└──────────────────────────────────────────────┘
```

## How it works

- The **Host half** listens to session events: after `turn/end` it waits a short delay, then sends the last N turns of user/assistant text through one **standalone lightweight LLM request** (never enters the session log, no tools, does not consume your conversation context) to produce a short suggestion. A new `user/message` or a session restart invalidates it immediately.
- The **Client half** mounts into the composer card via `conversation.input.overlay` and renders the suggestion into the editor through a React portal, aligned with the host placeholder's position and typography. While the ghost is visible the host placeholder is hidden via CSS `:has()`; theming uses only `--dsw-alias-*` tokens, so light/dark both work.
- **Tab acceptance** is handled in the `keydown` capture phase (ahead of the Lexical keymap) and defers to the command menu (`/`, `@` candidates) whenever it is open. Accepting calls the host's `inputActions.setDraft` and keeps focus in the composer — press Enter to send.
- Cross-process calls go through DSH's Typert RPC: the Host provides the `promptSuggestion` service (`get`/`dismiss`); the Client `$mount`s the matching namespace — the same conventions official plugins follow.

## Install

**Option A: Plugin Manager in the DSH desktop app / Web (recommended)** — Settings → Plugins → Install bundle, paste this repo URL or a local path.

**Option B: CLI** (pnpm-argument passthrough; the `desktop` profile is managed exclusively by the Electron app — install from inside it):

```bash
# local path
dsh plugin --profile <name> add /path/to/dsh-prompt-suggestion
# from GitHub
dsh plugin --profile <name> add github:zycFrancis/dsh-prompt-suggestion
```

Refresh the page once after installing (desktop: Cmd+R / reopen the window) so the Client module loads. Suggestions appear after the next completed turn.

## Configuration

**Zero-config by default**: suggestion generation fully follows the current
session — it uses the model and reasoning effort you are chatting with
(provider, model and reasoningEffort all come from the session's latest
request; only when the session specifies no effort does it fall back to the
model's lowest tier, with an automatic degraded retry on empty output).
Nothing to set up after installing.

Only override in the profile's `cordis.patch.yml` (or the plugin manager)
when you want to deviate:

```yaml
- id: prompt-suggestion
  name: dsh-prompt-suggestion
  config:
    enabled: true          # master switch
    # Leave provider/model/reasoningEffort unset = follow the current session (recommended);
    # fill them only to pin suggestions to a fixed route/effort (e.g. a cheaper model).
    historyTurns: 4        # recent turns fed to the model
    maxInputChars: 6000    # character cap for conversation input
    maxOutputTokens: 4096   # max tokens for the suggestion request (thinking models need headroom)
    delayMs: 600           # pre-generation delay after turn/end (0 = immediate)
    debugLog: false        # write diagnostics to /tmp/dsh-prompt-suggestion.log when true
```

## Behavior details

| Scenario | Behavior |
| --- | --- |
| Turn ended, composer empty | Delayed pre-generation; Client polls, appears within ~0.4–3s (~2s measured on deepseek-flash) |
| Press Tab | Ghost becomes real input, focus kept, ready to send |
| Press Esc | Dismissed for this turn |
| Type or paste anything | Ghost disappears |
| Send a message / turn starts | Host cache invalidated, in-flight generation aborted |
| Command menu open | Tab belongs to the menu; ghost survives after it closes |
| Switch sessions | Per-session suggestions; still there when you come back (same turn) |
| No model route available | Fails silently, never affects host features |
| Thinking models (e.g. GLM-5.3) | Effort follows the current session; falls back to the lowest tier, with degraded retry on empty output |

Each suggestion costs a few hundred input tokens and a few dozen output tokens on the configured route. Set `enabled: false` or uninstall if you do not want that.

## Development

```bash
pnpm install
node --test test/unit.mjs test/typert.mjs
```

- `lib/index.js` — Host half: event wiring, conversation collection, LLM generation, RPC service.
- `lib/typert.host.js` — Typert manifest (zod v4 codecs).
- `lib/client.js` — Client half: Remote contribution, ghost text component, keyboard handling.

Reload the plugin after changing Host code; refresh the page after changing Client code.

## License

MIT

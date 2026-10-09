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

```bash
# Option A: local path
dsh plugin install /path/to/dsh-prompt-suggestion

# Option B: from GitHub
dsh plugin install zycFrancis/dsh-prompt-suggestion
```

Refresh the Web page once after installing so the Client module loads. Suggestions appear after the next completed turn.

## Configuration

Override in the profile's `cordis.patch.yml` (or via the plugin manager):

```yaml
- id: prompt-suggestion
  name: dsh-prompt-suggestion
  config:
    enabled: true          # master switch
    provider: deepseek     # optional: explicit model route for generation
    model: deepseek-chat   #   fallback order: session's last request route → global default model
    historyTurns: 4        # recent turns fed to the model
    maxInputChars: 6000    # character cap for conversation input
    maxOutputTokens: 4096   # max tokens for the suggestion request (thinking models need headroom)
    delayMs: 600           # pre-generation delay after turn/end (0 = immediate)
```

## Behavior details

| Scenario | Behavior |
| --- | --- |
| Turn ended, composer empty | Delayed pre-generation; Client polls, appears within ~0.4–3s |
| Press Tab | Ghost becomes real input, focus kept, ready to send |
| Press Esc | Dismissed for this turn |
| Type or paste anything | Ghost disappears |
| Send a message / turn starts | Host cache invalidated, in-flight generation aborted |
| Command menu open | Tab belongs to the menu; ghost survives after it closes |
| Switch sessions | Per-session suggestions; still there when you come back (same turn) |
| No model route available | Fails silently, never affects host features |
| Thinking models (e.g. GLM-5.3) | Requests the lowest reasoning effort; 4096-token output headroom by default |

Each suggestion costs a few hundred input tokens and a few dozen output tokens on the configured route. Set `enabled: false` or uninstall if you do not want that.

## Development

```bash
pnpm install
node --test test/unit.mjs
```

- `lib/index.js` — Host half: event wiring, conversation collection, LLM generation, RPC service.
- `lib/typert.host.js` — Typert manifest (zod v4 codecs).
- `lib/client.js` — Client half: Remote contribution, ghost text component, keyboard handling.

Reload the plugin after changing Host code; refresh the page after changing Client code.

## License

MIT

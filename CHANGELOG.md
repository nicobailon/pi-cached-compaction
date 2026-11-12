# Changelog

## [Unreleased]

### Added
- **Compact when the context is full** — After a turn, once the context fills `compactAtPercent` of the model's window (90% by default), the session compacts from the warm cache while a summary still fits beside the conversation. Before, a 1M-token session reached Pi's own threshold with about 16k tokens left, the cached summary hit its output limit, and Pi's compaction ran at full price ($4.20 instead of about $0.45 on a 984k-token Opus session).
- **Token cap for compacting when full** — `compactAtTokens` (off by default) compacts once the context holds that many tokens, on any model, at the cap or `compactAtPercent`, whichever comes first. A percentage is a different size on every window; a cap keeps the context, and so the price of each request's cache read, under one size everywhere.
- **`/cached-compaction-settings`** (also `/cached-compaction settings`) — A menu for every setting (compact when full, compact before expiry and from what size, cache retention). Changes are saved to `cachedCompaction` in `~/.pi/agent/settings.json` and apply right away. `/cached-compaction` shows the "when full" mark for the current model.

### Fixed
- **Summary length** — The cached summary may use the model's output limit, reduced so the conversation and the summary fit the window, like Pi's own compaction. It was capped at 80% of `compaction.reserveTokens` (about 13k tokens), too short for large sessions. With less than 16k tokens of room, the cached path is skipped instead of attempted.

## [0.2.0] - 2026-10-23

### Highlights
- Kimi K3 on Moonshot's API keeps its cache for an hour in interactive sessions, so a coffee break no longer means paying to write the whole session again.
- The footer counts down Kimi's cache, and the session compacts just before it expires.
- Compacting before expiry now waits until a session holds 140k tokens, so shorter sessions keep their full history through a break.

### Added
- **Kimi K3's 1-hour cache** — On Moonshot's API (`moonshotai` and `moonshotai-cn`), interactive sessions now ask Kimi K3 for its 1-hour cache instead of the 5-minute default, so ordinary breaks don't expire it. The footer counts down either lifetime, and the session compacts before it expires. Writing a 1-hour cache costs 2× the input price; set `cacheRetention: "short"` to keep 5 minutes. Thanks @fungilation for the request ([#1](https://github.com/nicobailon/pi-cached-compaction/issues/1)).

### Changed
- **Compacting before expiry waits for bigger sessions** — It now starts at 140k tokens of context instead of 50k, so shorter sessions keep their full history through a break. Set `minContextTokens` under `cachedCompaction` in `~/.pi/agent/settings.json` to change it.
- **`/cached-compaction` wording** — When the last request didn't use the cache, it now says so in the same words as the compaction card.

## [0.1.0] - 2026-10-22

First release. Needs Pi 0.87.0 or newer.

### Highlights
- Compaction reads the prompt cache your session already built. About 99% of the summary request comes from the cache instead of being billed at full price; on a 667k-token Opus session that was $0.19 instead of about $1.40.
- The summary is written from the full tool output, not the first 2,000 characters of each result.
- When you step away, it compacts just before the cache expires, so your next message doesn't pay to write the whole session again.
- Every compaction shows a card comparing its cost with what Pi's own compaction would have cost.

### Added
- **Cached compaction** — The summary request repeats your conversation as it is (the same system prompt, tools and messages) and asks for the summary as the next turn. The result has Pi's format: older messages summarized, recent ones kept word for word, and the read and modified file lists carried forward. If the request can't be shown to match your last one byte for byte, or the model tries to call a tool, Pi's own compaction runs.
- **Compaction card** — After each compaction, a card under the summary shows how much came from the cache, the cost and the time, next to Pi's estimated cost for the same messages. Expand it with ctrl+o to see what the decision rested on. Every decision is also logged to `~/.pi/agent/cached-compaction.jsonl`.
- **Cache countdown and compacting before expiry** — The footer counts down the cache's remaining life (`⏱ 59m … ⏱ 0:25`, then `cache cold`). When Pi is idle with at least 50k tokens of context, the extension compacts 20 seconds before the cache expires. Turn it off with `compactBeforeExpiry: false`, or raise `minContextTokens`, under `cachedCompaction` in `~/.pi/agent/settings.json`.
- **Longer cache in interactive sessions** — Asks for the 1-hour cache on Anthropic, and a 12-hour cache for the system prompt and tools on GPT-5.6 and later, so ordinary breaks don't expire it. Set `cacheRetention: "short"` to keep Pi's default.
- **`/cached-compaction`** — Shows the cache right now, whether the next compaction would read it, and this session's compactions. `/cached-compaction cache-flag` turns on OpenAI's cache options for GPT models on opencode-go, which Pi doesn't send by default.
- **Providers** — Works with Anthropic, Claude on opencode-go, Claude through pi-claude-bridge, GPT-5.6 and later on `openai` and opencode-go, other Responses and Chat Completions APIs, and `openai-codex`. Google and other providers keep Pi's own compaction.

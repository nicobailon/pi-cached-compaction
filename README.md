# pi-cached-compaction

Pi compaction that reads the prompt cache your session already built. On big sessions it costs a fraction of Pi's, and the summary is written from the full tool output instead of 2,000-character excerpts.

https://github.com/user-attachments/assets/04cec926-4eaa-411b-ad1c-33aba6109323

![The cached compaction card in Pi: "07:42:48 /compact: cached, 99% of 667k from cache, 3k out, 29.5s, summary 5791 chars. vs Pi's compaction: 86% less, $0.19 instead of ~$1.4 (it sends ~328k tokens, none from cache). 07:42:48 saved, 666k tokens summarized." The footer below it reads "~/pi-subagents-app ⏱ 59m · claude-opus-5-5 · high".](media/card-667k.png)

A real card from a 667k-token Opus 5.5 session, a subagent implementing a GitHub issue over 393 responses, replayed through pi-claude-bridge. Claude Code bills by subscription, so the bridge's own card compares tokens; the dollars here are the same token counts at Anthropic's API prices for Opus 5.5. Two things the card doesn't show:

- **The summary saw all the tool output.** Pi's compaction would have cut 109 of the session's 521 tool results to 2,000 characters, which drops 61% of the tool output before the model reads it. That output was already in the cache, so reading all of it is part of the $0.19.
- **The footer counts down to the expensive part.** At this size, letting the cache expire means your next message rewrites all 667k tokens, $5.33 at the 1-hour rate. If Pi is idle, the extension compacts 20 seconds before that.

## Why this exists

Pi's compaction swaps the system prompt, drops the tools, and flattens the messages into text. None of that matches what the provider has cached, so every token of the summary request is billed at full price.

It also cuts every tool result down to its first 2,000 characters, and the bigger the session, the more that throws away. Long sessions do their work in long outputs: whole files, test runs, build logs. The summarizer sees only the start of each one, so it misses the bottom of the file and the failures listed at the end of the test run. In eleven of my sessions that passed 700k tokens, Pi's compaction would have shown it 35–57% of the tool output, leaving out 300k to 1M characters per session.

![One 40 KB test run, as the summarizer sees it. Pi's compaction shows it the first 2,000 characters, and the failures are down at the end. pi-cached-compaction shows all of it, read from the cache.](media/test-run.png)

I wrote this extension to keep the system prompt, the tools, and the messages as they are, and append one instruction instead, as the next turn of the same conversation:

![What each compaction sends. Pi's compaction: a summarizer prompt, then the older messages as text with tool output cut; nothing from cache. pi-cached-compaction: the tools, the system prompt and messages 1 to N, the same bytes as your last turn, plus a new "summarize this" instruction; about 99% from cache.](media/what-it-sends.png)

The provider reads nearly all of it from the cache at about a tenth of the input price, and the model writing the summary sees the whole conversation, tool output included. The result looks like Pi's: its checkpoint format, its window of recent messages kept as they are, and the read and modified file lists carried forward.

## vs Pi's compaction

- **Reads the cache.** About 99% of the summary request comes from the cache at normal compaction sizes.
- **Sees all the tool output, at the cache price.** Pi's compaction shows the model the first 2,000 characters of each tool result. This one shows all of it, and since that output is already in the cache, including it costs no more than the rest of the session.
- **Compares itself with Pi's.** Each compaction gets a card showing its cost next to what Pi's compaction would have cost for the same messages.
- **Compacts before the cache expires.** If you step away, it compacts from the warm cache, so your next message doesn't pay to write the whole session again.
- **Falls back cleanly.** It checks that the request repeats your last one byte for byte up to the new part. When it can't prove that, Pi's own compaction runs as usual. (Claude through pi-claude-bridge is checked by the bridge instead; see [Providers](#providers).)

| | Pi's compaction | pi-cached-compaction |
|---|---|---|
| What it sends | the older messages as text, under its own system prompt | your conversation as it is, plus one instruction |
| Prompt cache | not used | about 99% read from it at normal compaction sizes |
| Tool output the summary sees | the first 2,000 characters of each result | all of it, read from the cache |
| Cost | full price, for the older messages only | 0.1× for the whole session: less once there's a lot to summarize, more on small sessions ([numbers](#what-it-costs)) |
| After a long break | your next message rewrites the whole expired cache | it compacts just before the cache expires, so there's much less to rewrite |
| Cache lifetime | Pi's default (5 minutes on Anthropic) | 1 hour in interactive sessions, which Anthropic bills at 2× per write instead of 1.25× ([why](#compacting-before-the-cache-expires)) |
| What you see | the summary | the summary, a card comparing the cost with Pi's compaction, and a cache countdown in the footer |

## Install

```bash
pi install npm:pi-cached-compaction
```

Then run `/reload`. It needs Pi 0.87.0 or newer, and everything is on by default.

## What you'll see

**The card** at the top appears under the summary after each compaction. It's shown to you only, never sent to the model, and stays in the session after a resume. Its second line compares this compaction with what Pi's would have cost for the same messages: green when this one cost at least 5% less, amber when it cost at least 5% more, and "about the same" in between. Models with no price, like Claude Code's subscription models through pi-claude-bridge, get the comparison in tokens not read from the cache instead of dollars.

**Pi's side is an estimate,** since Pi's compaction never runs. The extension serializes the messages exactly as Pi's compaction would, then counts tokens at the rate the provider counted for this summary request, so it follows each model's tokenizer. In my tests it came within 2–12% of what Pi's compaction actually sent, always a little high, so the card slightly overstates the saving.

**When the cache can't be used,** the card says why and what Pi's compaction did instead. Expand it with ctrl+o to see what the decision rested on:

![The expanded card: "13:48:54 /compact: Pi's compaction, request field "reasoning" differs. cache: lifetime 30 min (OpenAI's minimum), 30 min left. last request: 4 s ago, 20 messages, 2k prompt tokens, 1 new since. request: thinking low, shared 12h prefix. last request had: {"effort":"high","summary":"auto"}. summary request had: {"effort":"low","summary":"auto"}. 13:48:59 Pi's compaction saved: 0% of 923 from cache, 384 out, $0.0003, summary 1243 chars. log: ~/.pi/agent/cached-compaction.jsonl"](media/card-fallback.png)

**The countdown** in the footer shows how long the cache has left. Sending a message restarts it, and it goes `⏱ 59m … ⏱ 2m … ⏱ 0:25` (in the warning color for the last 30 seconds), then `cache cold`. In powerline-footer it shows in the `extension_statuses` segment. The lifetime comes from the cache tier the provider reports writing (Anthropic and pi-claude-bridge report it), else the model's declared lifetime, else OpenAI's 30-minute minimum for GPT-5.6 and later, else Kimi K3's 5-minute or 1-hour option. Models with none of those show no countdown.

**`/cached-compaction`** shows the cache right now, whether the next compaction would take the cached path, and this session's log:

![The output of /cached-compaction: "pi-cached-compaction · opencode-go/gpt-6-luna. cache: ⏱ 29m left (lifetime 30 min, OpenAI's minimum). next compaction: cached path; last request 4 s ago with 186 messages, 1 since. The request prefix is checked when it runs. before expiry: on, from 50k tokens of context · retention long. log: ~/.pi/agent/cached-compaction.jsonl. This session: 23:43:49 /compact: cached, 99% of 50k from cache, 2k out, 11.3s, summary 3263 chars. vs Pi's compaction: 62% less, $0.0013 instead of ~$0.0035 (it sends ~27k tokens, none from cache). 23:43:49 saved, 49k tokens summarized."](media/status-command.png)

**The log.** Every decision is also appended to `~/.pi/agent/cached-compaction.jsonl`, which moves to `.1` past 5 MB. Each line records what triggered the compaction, the path it took and why, the request settings, the provider's cache usage, the estimate for Pi's compaction, and the timing. When the request didn't match, it includes up to 200 characters of each version around the first difference. The log stays on your machine.

```sh
jq -c 'select(.event == "compact") | {at, trigger, outcome, reason, cacheRead: .response.usage.cacheRead, piEstimate}' ~/.pi/agent/cached-compaction.jsonl
```

## Common tasks

| Want | Do |
|---|---|
| See the cache now and this session's compactions | `/cached-compaction` |
| See why a compaction didn't use the cache | expand its card with ctrl+o |
| Stop compacting before the cache expires | `"compactBeforeExpiry": false` in [Settings](#settings) |
| Compact before expiry only on bigger sessions | raise `minContextTokens` |
| Keep Pi's 5-minute cache and its 1.25× writes on Anthropic | `"cacheRetention": "short"` |
| Get the countdown for GPT on opencode-go | `/cached-compaction cache-flag` (see [Providers](#providers)) |
| Get the countdown on another model | declare a lifetime with Pi's `modelOverrides.promptCache` |
| Look through past decisions | the `jq` line under [What you'll see](#what-youll-see) |

## Settings

Add a `cachedCompaction` key to `~/.pi/agent/settings.json`. Project settings files don't apply to this key, and an unknown key is an error.

| Setting | Default | What it does |
|---|---|---|
| `compactBeforeExpiry` | `true` | compact 20 s before the cache expires, when idle |
| `minContextTokens` | `140000` | the smallest context worth compacting before expiry |
| `cacheRetention` | `"long"` | ask for the longer cache in interactive sessions (2× writes on Anthropic and Kimi); `"short"` keeps Pi's default |

```json
{
  "cachedCompaction": {
    "compactBeforeExpiry": false
  }
}
```

## Compacting before the cache expires

If you step away, the cache expires and your next message pays to write the whole session again. So 20 seconds before expiry, the extension compacts from the still-warm cache, and your next message rewrites a summary-sized context instead. It only does this when:

- Pi is idle with nothing queued,
- Pi's auto-compaction is on,
- the context holds at least 140k tokens (`minContextTokens`),
- and the cached path is available.

Otherwise it does nothing and the cache cools. Models without a [countdown](#what-youll-see) never compact before expiry.

The threshold is in tokens rather than percent because rewriting an expired cache costs in proportion to its size, and on 1M-token models a percentage would almost never trigger.

**The longer cache.** A 5-minute cache expires during most breaks, so in interactive sessions the extension asks for the longer one (`PI_CACHE_RETENTION=long`) unless you've set that variable yourself. That's 1 hour instead of 5 minutes on Anthropic and Kimi K3, and a 12-hour shared system prompt on GPT-5.6 and later (see [Providers](#providers)). It isn't free: writing a 1-hour cache costs 2× the input price, instead of 1.25× on Anthropic and 1× on Kimi, though reads cost the same. Headless runs (`pi -p`, JSON mode, subagent processes) keep the short cache, since nobody pauses there. The choice is made once per session, because moving a cache up a tier means writing all of it again.

## Providers

| Provider | Cached compaction | Countdown and compact before expiry | Longer cache (interactive) |
|---|---|---|---|
| Claude via pi-claude-bridge | yes, on a copy of the Claude Code conversation | yes, 1 hour | Claude Code decides |
| Anthropic API | yes | yes, 1 hour | 1 hour instead of 5 minutes |
| Claude on opencode-go | yes | yes, 1 hour | 1 hour instead of 5 minutes |
| GPT-5.6+ on `openai` | yes, not tested live yet | yes, 30 minutes | 12-hour shared system prompt |
| GPT-5.6+ on opencode-go | yes | after `/cached-compaction cache-flag` (below) | after `cache-flag` |
| Kimi K3 on `moonshotai` and `moonshotai-cn` | yes, not tested live yet | yes, 5 minutes or 1 hour | 1 hour instead of 5 minutes |
| Other Responses and Chat Completions APIs | yes | only with a declared lifetime (`modelOverrides.promptCache`) | the provider's own |
| `openai-codex` (ChatGPT sign-in) | yes, not tested live yet | no, there's no documented lifetime | no |
| Google and others | no, Pi's compaction runs | no | no |

**Claude through pi-claude-bridge.** These models run in Claude Code, so there's no HTTP payload for the extension to compare. Instead it sends the summary request with the bridge's `x-claude-bridge-fork: 1` header. The bridge runs it on a temporary copy of the live Claude Code conversation, which reads its cache, and then deletes the copy. The live conversation is only read. A bridge without fork support runs the request as a one-shot: the summary still works without the cache hit, and the card shows that. Claude Code keeps any tool result over about 50 KB as a file with a 2 KB preview, so for those the summary sees the preview, the same as the live model did.

Claude Code bills by subscription, so the bridge prices these models at $0. Here, compacting before expiry saves subscription quota and the slow first reply after a cold cache, not money. It also replaces the older part of the conversation with a summary well before Pi would compact a 1M-token model. If you'd rather keep the full context through long breaks, raise `minContextTokens` or turn it off. Claude Code also picks its own cache lifetime (1 hour on a subscription), so `cacheRetention` doesn't apply.

**GPT-5.6 and later.** With the longer cache, the system prompt and tools get a 12-hour cache under one key per project, so later sessions in the same project read them instead of writing them again. The conversation keeps OpenAI's 30-minute cache, and that's what the countdown follows.

| | Pi alone | With the extension |
|---|---|---|
| System prompt and tools | each session writes them at 1.25×, and they last 30 minutes | written once at 2.5× and kept 12 hours; later sessions in the project read them at 0.1× |
| Conversation | 30 minutes | 30 minutes (the countdown follows this) |

The 12-hour write costs an extra 1.25× of that prefix once, and the second session in the project that day earns it back. With a full set of extensions the prefix is around 19k tokens. Pi prices every cache write at the 30-minute rate, so its cost display understates the 12-hour part.

**Kimi K3 on Moonshot's API.** Kimi picks a cache lifetime of 5 minutes or 1 hour per request, and keeps a cache at the lifetime it was first written with. Pi doesn't send that option, so with the longer cache the extension adds it, and the countdown follows the lifetime it asked for. Pi's model catalog prices Kimi's cache writes at $0, so its cost display and the card leave them out. Kimi through opencode-go, OpenRouter, or Kimi For Coding keeps the host's own caching.

**opencode-go.** Pi doesn't send OpenAI's cache options to opencode-go's GPT models, so they get no 12-hour prefix and no countdown until you turn the options on. Run `/cached-compaction cache-flag` and it adds them to `~/.pi/agent/models.json` for every opencode-go model that has them on `openai`, then switches the current session over. It rewrites the file as plain JSON, so if yours has comments it stops and you add this by hand:

```json
{
  "providers": {
    "opencode-go": {
      "modelOverrides": {
        "gpt-6-luna": { "compat": { "supportsExplicitPromptCacheMode": true } },
        "gpt-5.6-luna": { "compat": { "supportsExplicitPromptCacheMode": true } }
      }
    }
  }
}
```

Pi's own cache warmer only runs for models with a declared lifetime. If you want it to keep caches warm during long runs, add `"promptCache": { "short": 1800, "long": 1800 }` next to `compat`.

## What it costs

Pi's compaction keeps the last 20k tokens as they are and sends only what's older, as text with each tool result cut to 2,000 characters, at full price. This extension sends the whole session and pays the cache-read price (0.1×) for nearly all of it. So on small sessions, and on sessions that mostly read big files, Pi's is often cheaper: it has little to send. Once the older part is most of the session, which is usually the case when auto-compaction fires, reading everything at 0.1× costs less. The card shows both numbers every time, so you can see which case you're in.

The part that isn't cached is the instruction (about 400–600 tokens, depending on the model) plus anything added since the last request. That stays about the same size, so the cached share grows with the session: in my tests 83% on a 2k-token session, 95% at 10k and 99% at 44k. For auto-compaction on a 200k model it works out to 99.7%. Auto-compaction can also fire in the middle of a run. Then the latest tool results are new too, but at that size they're still a small share.

What I measured, at the prices in Pi's model catalog. The Opus row is the session at the top, priced at Anthropic's API rates, and its Pi column is the card's estimate. The rest are GPT through opencode-go, where I also ran Pi's compaction:

| Session at compaction | Pi's compaction | pi-cached-compaction |
|---|---|---|
| 667k tokens, a real coding session (`claude-opus-5-5`) | ~328k sent, ~$1.40 | 667k sent, 99% cached, $0.19 |
| 50k tokens, many small reads of source files (`gpt-6-luna`) | 26k sent, $0.0032 | 50k sent, 99% cached, $0.0013 |
| 44k tokens, ten whole docs read (`gpt-6-luna`) | 5.9k sent, $0.00090 | 44k sent, 99% cached, $0.00097 |
| 10k tokens, mostly long answers (`gpt-5.6-luna`) | 6.0k sent, $0.00224 | 10k sent, 95% cached, $0.00123 |
| 9k tokens, mostly long answers (`gpt-6-luna`) | 4.9k sent, $0.00087 | 8.8k sent, 94% cached, $0.00050 |
| 2k tokens, a few tool calls (`gpt-6-luna`) | 0.3k sent, $0.00009 | 2.2k sent, 83% cached, $0.00035 |

Where the two cost about the same, the difference is in what the summary was written from: the full tool output instead of 2,000-character excerpts.

## How it works

`/compact`, Pi's automatic compaction, and compacting before expiry all go through the same checks. The cached path is taken only when all four hold:

1. Same model as the last request, and the conversation only grew since then. New messages and extension notices are fine. Edits, `/tree`, a model switch, or a context overflow are not.
2. The last request used the cache, and the cache hasn't expired.
3. The instruction can quote where the kept messages start (below).
4. The rebuilt request is identical to the last one up to the new part. This runs on the exact request Pi would send, using Pi's own serializer, so a different thinking level (on most models), an edited message, or a field another extension changed all count. Nothing is sent when it fails.

If any check fails, Pi's own compaction runs. When compacting before expiry, nothing runs and the cache cools.

**Where the summary stops.** Pi keeps about the last 20k tokens of messages (its `keepRecentTokens` setting) word for word after the summary. The extension uses Pi's own cut point, so the summary has to stop where those messages begin. But the model reads the kept messages too, since they're part of the cached conversation:

![Where the summary stops. Messages 1 to K-1 are summarized, Pi keeps messages K to N word for word, and the new instruction says: Summarize what comes before the message starting with the text of message K.](media/summary-boundary.png)

So the instruction quotes the first kept message as the model sees it (and says which repeat it is, if that text appears more than once), says how many messages are kept, and tells the model to write the summary as if the conversation ended before the quoted one. In my repeated tests where Pi's cut fell in the middle of a turn, no summary reported kept work as done. If the first kept message has nothing to quote (only an image, or only thinking), it doesn't guess: Pi's own compaction runs.

**Tools during the summary.** On the `openai` provider, the summary request sets `tool_choice: "none"`, which OpenAI keeps out of the cached prefix. Elsewhere changing it costs cache (on Anthropic it drops the message cache), so the model sees your tools and is told not to call them. If it calls one anyway, Pi's own compaction runs. In my tests no model tried.

## Limitations

- Without a known cache lifetime, the extension can't tell a cold cache from a warm one. A compaction after a long break then pays to rewrite the whole session. Declare a lifetime with Pi's `modelOverrides.promptCache`, or, for GPT on opencode-go, run `/cached-compaction cache-flag`.
- Through pi-claude-bridge the extension can't check the request. If the bridge can't copy the whole Claude Code conversation, the summary is still correct but reads less from the cache, and the card shows the low cache share.
- Fields that extensions loaded before this one add to provider requests are copied into the summary request, such as codex-fast's `service_tier`. Changes from extensions loaded after it aren't seen, so the request can miss the cache. The summary is still correct, it just costs about what Pi's compaction would, and the card shows the low cache share.
- When a later compaction falls back to Pi's own, its read and modified file lists start over. Pi doesn't carry the lists forward from an extension's compaction.
- Right after a compaction, the card is the session's last entry. A second `/compact` then says "Nothing to compact (session too small)" instead of "Already compacted". Both mean there's nothing new to compact.

## Documentation

[docs/live-tests.md](docs/live-tests.md) has every test run behind the numbers here: the cache share on each model, how close the card's estimate of Pi's compaction came, where the summary stops when Pi's cut falls mid-turn, Claude and GPT through opencode-go, and cache tiers through Claude Code.

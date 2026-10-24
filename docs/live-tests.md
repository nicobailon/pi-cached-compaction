# Live tests and measurements

The measurements behind the README. Run on 2026-10-21 with Pi 1.3.0 in RPC mode, with a logger recording each request's cache fields and the cache usage the provider reported.

## Compaction across models

Unless noted, a run makes three tool-using turns (read, edit, bash), runs `/compact`, makes one more edit, and runs `/compact` again. The percentage is the share of the summary request's prompt read from the cache. In these small sessions the summary instruction keeps it in the 80s: the summary request read everything the previous turn had sent except its last 3 tokens. The instruction was about 350 tokens in these runs. Since its wording changed (see [Where the summary stops](#where-the-summary-stops)) it measures about 415 tokens on `gpt-6-luna` and 610 on `claude-haiku-5-5`.

| Model | API | Two compactions |
|---|---|---|
| `pi-claude/claude-opus-5-5` | Claude Code (bridge) | 96%, 96%; 99%, 99% with a full set of other extensions |
| `pi-claude/claude-sonnet-5-5` | Claude Code (bridge) | 96%, 96% |
| `opencode-go/claude-haiku-5-5` | Anthropic Messages | 86%, 87% |
| `opencode-go/gpt-6-luna` | OpenAI Responses | 83–84%, 85–86% |
| `opencode-go/gpt-5.6-luna` | OpenAI Responses | 83–84%, 84–86% |
| `opencode-go/grok-4.7` | OpenAI Responses | 90%, 90% |
| `opencode-go/kimi-k2.7-code` | OpenAI Chat Completions | 79%, 86% |

`deepseek-v4.1-flash` and `muse-spark-1.3-contributor` didn't run: opencode-go rejects them until the workspace allows Global regions and endpoints that train on request data. With every turn failing, the extension handed compaction to Pi's, which failed the same way.

Every run that used tools left the edited file correct.

## Pi's side of the card

The card's comparison needs what Pi's compaction would have sent, without running it. The extension serializes the summarized messages with Pi's own `serializeConversation` (tool output cut to 2,000 characters, thinking left out), adds the previous summary, Pi's prompts, and the second request Pi makes for a split turn, and converts characters to tokens.

Pi's usual rule of 4 characters per token was off by a third either way: +28% on GPT prose, −34% on Claude reading code. So the extension scales it by how the provider counted the summary request itself, which holds the same conversation: the provider's prompt tokens against Pi's estimate for those messages.

To check it, each run built a session with the extension, saved a copy, and ran `/compact` on the cached path. Then the copy was resumed without the extension, so Pi's own compaction ran on the same messages, and its reported input was compared with the estimate.

| Session | Model | Kept window | Estimate | Pi's compaction sent | Error | Pi's 4-chars rule alone |
|---|---|---|---|---|---|---|
| three whole files read | `gpt-6-luna` | 1.5k | 1,908 | 1,852 | +3.0% | +6.8% |
| three 400-word answers | `gpt-6-luna` | 1.5k | 1,084 | 1,058 | +2.5% | +28% |
| three whole files read | `claude-haiku-5-5` | 1.5k | 3,247 | 3,127 | +3.8% | −34% |
| three 400-word answers | `claude-haiku-5-5` | 1.5k | 1,812 | 1,633 | +11% | −21% |
| 31k: whole docs and long answers | `gpt-6-luna` | 20k | 1,851 | 1,651 | +12% | |
| 50k: whole docs and long answers | `claude-haiku-5-5` | 20k | 2,973 | 2,698 | +10% | |
| 50k: many small reads of source files | `gpt-6-luna` | 20k | 27,463 | 26,358 | +4.2% | |

The estimate always came out a little high, so the card's saving reads a few points better than the real one: 62% on the last run, where the real costs ($0.0013 against $0.0032) give 58%. On the two sessions that read whole docs, Pi's compaction was the cheaper one ($0.00042 against $0.00075 on GPT, $0.00097 against $0.0011 on Haiku), because cutting each result to 2,000 characters left it little to send. The cards said so.

Sessions with a lot of thinking read higher. Claude keeps earlier thinking in its context at full length, while Pi stores only the shorter summary of it and leaves thinking out of its compaction. On one 500k-token Opus session at xhigh thinking, taking the reported reasoning tokens out would have lowered the scaling from 1.81 to 1.63, so the estimate there reads about 10% higher on top of the usual error.

## Where the summary stops

Pi keeps the newest messages as they are, and the summary has to stop where they begin. To test that, `keepRecentTokens` was set to 100 so Pi's cut falls inside a two-turn session: usually on the `cat notes.txt` call in the middle of the first turn. A run counts as a leak when the summary's Done list reports a tool call from the kept messages.

| Model | Earlier wording | Current wording |
|---|---|---|
| `opencode-go/claude-haiku-5-5` | 6 of 6 leaked | 0 of 6 |
| `opencode-go/gpt-6-luna` | 2 of 3 leaked | 0 of 6 |

The earlier wording quoted the first kept message and said to summarize only what came before it. The models often summarized the whole conversation anyway. The current wording also says how many messages are kept, tells the model to treat the conversation as ending before the quoted message, and repeats the stop point at the end. With it, the kept work shows up under Next Steps, as not yet done, or not at all.

## Claude through opencode-go

`claude-haiku-5-5` is the only Claude model on opencode-go. It uses Anthropic's Messages API, and opencode-go requires an `x-opencode-session` header, which Pi fills with the session id. The summary request uses the same session id, so it's routed like the agent's own requests.

- opencode-go honors the 1-hour cache and reports it: every write came back as `ephemeral_1h_input_tokens`. The countdown showed `⏱ 60m`, "reported by the provider".
- The 1-hour lifetime holds. Two 24k-token prefixes were written side by side, one with a 1-hour TTL and one with 5 minutes. After 6.7 idle minutes the 1-hour one was read in full from the cache, and the 5-minute one had expired and was written again. These were direct API requests.
- Two compactions of a 3k-token session took the cached path: 3,088 of 3,634 prompt tokens from the cache (85%), then 3,461 of 4,034 (86%).
- This run also found the second summary listing `<modified-files>` twice. The model had copied the block from the first summary. File lists in the model's text are now replaced by the merged ones.

## GPT through opencode-go

`gpt-6-luna` / `gpt-5.6-luna`:

| Scenario | Result |
|---|---|
| Thinking off, high, or xhigh; long or short retention | all cached, 83–86% |
| 44k-token session (ten docs read) | 99% / 99% |
| Same with a full set of other extensions loaded (62k tokens) | 99% / 99% |
| Automatic compaction, triggered three times mid-run | 77, 82, 80% / 80, 81, 85% |
| Idle 12, 17, or 24 minutes, then `/compact` | 83–84% every time |
| Idle 32 or 62 minutes, long or short retention | 0%: the cache had expired |
| Declared 75 s lifetime, `compactBeforeExpiry` on | compacted 20 s before expiry, 83% / 84% |
| Declared 75 s lifetime, `/compact` after 2 idle minutes | skipped (cache expired), Pi's compaction ran |
| Thinking level changed before `/compact` | skipped (`request field "reasoning" differs`), Pi's compaction ran |
| Model switched before `/compact` | skipped (nothing sent to this model yet), Pi's compaction ran |
| An extension message arrived while idle, then `/compact` | cached, 1,510 of 1,513 from the cache |
| `tool_choice: "none"` on the summary request | 72 fewer tokens read from the cache, every time |
| Second session in the same project, first request (flag on) | 1,261 of 1,264 cached; none with Pi's per-session key |
| 12-hour entry, idle 40 minutes (direct API requests) | still cached, both as a breakpoint on the system prompt and as the request's lifetime; a 30-minute entry beside it had expired |
| Tools, then `/compact` twice, with the flag (12h prefix, shared key) | 83, 85% / 84, 86%; countdown `⏱ 29m` |
| Pi's own compaction with the flag | 0 tokens written to the cache, where it used to write its whole prompt at 1.25× |

The flag is `supportsExplicitPromptCacheMode` (see the README).

## `tool_choice`

OpenAI's guide recommends `tool_choice: "none"` to stop tool calls without changing the cached prefix. Measured on GPT through opencode-go, it isn't quite free: the summary request read exactly 72 fewer tokens from the cache every time, at any session size. On Grok through opencode-go it cut the cache off after the tool definitions (62–69% instead of 90%). That's why the extension only sets it on the `openai` provider. No model called a tool in any test.

## Cache tiers through Claude Code

A cache can't move up a tier cheaply, which is why the retention is chosen once per session:

```
 5m entry, then a 1h request   → full rewrite at 2×       (42,132 tokens written)
 1h entry, then a 5m request   → read as normal           (53,459 read, 67 written)
 idle 8 min on 5m              → expired, rewrite         (39,707 written)
 idle 8 min on 1h              → still warm
```

So "5 minutes while working, 1 hour when idle" costs more than choosing 1 hour from the start. With the 1-hour cache, Pi's own cache warmer rarely fires, which is fine: it stops after 30 idle minutes, before a 1-hour cache needs a refresh.

## pi-claude-bridge

On `pi-claude/claude-haiku-4-5` after three turns: 10,793 of 11,437 prompt tokens came from the cache, the main Claude Code transcript was unchanged, and the copy was deleted. Claude Code reports a 1-hour cache on a subscription, so the countdown showed `⏱ 59m`.

## Opus 5.5 at 667k (the README's card)

I copied a real session, an Opus 5.5 subagent implementing a GitHub issue (393 responses, 521 tool results), and opened it with pi-claude-bridge and this extension in a separate agent directory. One short turn put the conversation in Claude Code's cache (666,303 tokens written; the session had reported 767k when it ran), then `/compact` ran:

- 665,973 of 667,091 prompt tokens came from the cache, 2,598 tokens out, 29.5 s.
- Pi's compaction would have sent about 328k tokens (the card's estimate).
- At Anthropic's API prices for `claude-opus-5-5` ($4/M input, $20/M output, $0.20/M cache reads, cache writes at the 1-hour rate of 2× input), that's $0.19 against about $1.40, 86% less. The bridge prices the model at $0, so these dollars come from running the logged token counts through Pi's `calculateCost`.
- 109 of the 521 tool results were over 2,000 characters. Pi's serializer would have dropped 557,845 of their 918,846 characters (61%).
- Had the cache expired instead, the next message would have written all 666k tokens again: $5.33 at the 1-hour rate.

For comparison I also built an 895k-token session out of nothing but whole-file reads. There Pi's compaction would send only about 53k tokens, since it cuts every read to 2,000 characters, so the cached path was just 12% cheaper ($0.22 against about $0.25). That's the worst case the README describes.

That run also showed Claude Code's own limit: it keeps a tool result over about 50 KB as a file and puts a 2 KB preview in the conversation. Through the bridge, the summary sees what the live model saw, previews included.

## How much tool output Pi's compaction shows

Pi's serializer keeps the first 2,000 characters of each tool result (`truncateForSummary` in Pi's compaction utils). I counted what that leaves in every session of mine that passed 700k tokens, all Opus 5.5 subagent runs doing real issue work:

| Peak context | Tool results | Over 2,000 chars | Tool output | Pi's compaction shows |
|---|---|---|---|---|
| 814k | 1,879 | 272 | 2.09M chars | 52% |
| 799k | 1,120 | 128 | 1.09M chars | 44% |
| 799k | 1,353 | 193 | 1.62M chars | 57% |
| 798k | 561 | 164 | 1.40M chars | 37% |
| 791k | 865 | 148 | 1.46M chars | 38% |
| 768k | 479 | 74 | 0.61M chars | 50% |
| 767k | 521 | 109 | 0.92M chars | 39% |
| 756k | 555 | 101 | 0.90M chars | 41% |
| 748k | 501 | 95 | 0.97M chars | 35% |
| 747k | 491 | 94 | 0.72M chars | 46% |
| 719k | 439 | 86 | 0.66M chars | 46% |

Only 11–29% of the results run past 2,000 characters, but they hold most of the output, so 300k to 1M characters per session never reach the summarizer. This counts the whole session; Pi keeps its most recent 20k tokens out of the summary, so the summarized part loses slightly less.

## Mid-run compaction and large tool results

`pi-claude/claude-opus-5-5` at thinking high with Claude Code 2.1.308, in a separate agent directory. The mid-run test sets the threshold about 40k tokens in and has the model read files one per response:

| Test | Bridge `c459fde` | Bridge `c015275` |
|---|---|---|
| One read of a 108 KB file, two short turns, then `/compact` | copied 9/9 messages, 4,236 of 4,971 from the cache (85%) | copied 9/9, 4,157 of 4,804 (87%) |
| Auto-compaction mid-run, first | nothing to copy yet, 1,960 of 45,695 (4%) | copied 8/10 from the running query, 39,329 of 51,491 (76%) |
| The same run's second auto-compaction | copied 4 of 10, 1,960 of 50,155 (4%) | copied 8/10, 38,840 of 51,231 (76%) |

- Claude Code still keeps the 108 KB read as a file with a 2 KB preview, so that's what the summary sees.
- On `c459fde` a mid-run fork read only the tool definitions (1,960 tokens), even for the messages the bridge copied. My two real auto-compactions that day (507k and 529k) were both mid-run and read 3,117. The fork sent a different system prompt from the live query's, a restart after a mid-run compaction ended the copied prefix early, and a fork during the session's first query had nothing to copy. pi-claude-bridge `c015275` fixed all three: each fork now reads everything the previous request had cached (39,331 and 38,842).
- The same mid-run test on direct providers, through opencode-go, also read everything the previous request had cached. Claude Haiku 5.5 read 39,647 of 51,776 (77%) and 38,663 of 51,021 (76%) against previous requests of 39,649 and 38,665. GPT-6 Luna read 36,140 of 43,663 (83%) against 36,143. The rest is the tool result that had just come back plus the instruction, about 12k tokens, a small share at real session sizes.

## Not yet tested live

- The `openai` provider (no API credits). GPT-6 models there carry the reasoning effort as a trailing `configuration_update` item after the cache breakpoint, which the prefix check treats like Anthropic's trailing effort message. That path is checked against Pi's own OpenAI serializer for `gpt-6.1-sol` and `gpt-5.5`.
- `openai-codex` (ChatGPT sign-in).
- Kimi K3 on `moonshotai` and `moonshotai-cn`. Its 1-hour cache option and countdown are covered by unit tests only.

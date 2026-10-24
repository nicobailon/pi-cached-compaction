import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	convertToLlm,
	estimateTokens,
	serializeConversation,
	sessionEntryToContextMessages,
	type FileOperations,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** Entry types that never add model input, so they may sit between the captured request and compaction. */
const CONTEXT_FREE_ENTRY_TYPES = new Set(["custom", "label", "session_info", "usage", "thinking_level_change"]);
const MESSAGE_ARRAY_KEYS = ["messages", "input"] as const;
const OUTPUT_LIMIT_KEYS = new Set(["max_tokens", "max_output_tokens", "max_completion_tokens"]);
/** Pi's summarization system prompt and instructions around the serialized messages: about 1,200 characters in Pi 1.3. */
const PI_PROMPT_CHARS = 1_200;

export type Payload = Record<string, unknown>;

/** The captured provider payload whose cache entry a summary request extends, and the field that holds its messages. */
export interface CachedPrefix {
	payload: Payload;
	key: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The payload field that carries the conversation, for the provider APIs this extension supports. */
export function messageArrayKey(payload: Payload): string | undefined {
	return MESSAGE_ARRAY_KEYS.find((key) => Array.isArray(payload[key]));
}

function sameMessage(a: AgentMessage, b: AgentMessage): boolean {
	// Pi stamps a custom message's entry when it saves it, which can be well after the message was sent.
	if (a.role === "custom" && b.role === "custom") return a.customType === b.customType && JSON.stringify(a.content) === JSON.stringify(b.content);
	if (a.role !== b.role || a.timestamp !== b.timestamp) return false;
	return a.role !== "toolResult" || b.role !== "toolResult" || a.toolCallId === b.toolCallId;
}

/** The model input a message or custom-message entry adds. Extensions send custom messages (subagent and intercom notices, for example). */
function entryMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") return sessionEntryToContextMessages(entry)[0];
	return undefined;
}

/**
 * Messages the branch gained after the captured request, or why the branch no longer extends
 * that request (navigation, edits, or entries that add model input).
 */
export function trailingMessages(entries: SessionEntry[], transcript: AgentMessage[]): { messages: AgentMessage[] } | { reason: string } {
	const last = transcript.findLast((message) => message.role !== "system");
	const index = !last
		? -1
		: last.role === "custom"
			// Pi saves a custom message when it delivers it, so its entry is the first matching one stamped no earlier than the message.
			? entries.findIndex((entry) => entry.type === "custom_message" && Date.parse(entry.timestamp) >= last.timestamp && sameMessage(sessionEntryToContextMessages(entry)[0], last))
			: entries.findLastIndex((entry) => entry.type === "message" && sameMessage(entry.message, last));
	if (index === -1) return { reason: "its last message is no longer on this branch" };
	const messages: AgentMessage[] = [];
	for (const entry of entries.slice(index + 1)) {
		const message = entryMessage(entry);
		if (message) messages.push(message);
		// Compaction during a run appends its entry after messages the next request carries behind the new summary.
		else if (entry.type === "compaction" && transcript.some((message) => message.role === "compactionSummary" && message.timestamp === Date.parse(entry.timestamp))) continue;
		else if (!CONTEXT_FREE_ENTRY_TYPES.has(entry.type)) return { reason: `a ${entry.type} entry came after it` };
	}
	return { messages };
}

function canonical(value: unknown): string {
	// Pi moves the cache breakpoint to the newest message on every request; it is not part of the cached content.
	return JSON.stringify(value, (key, field) => (key === "cache_control" ? undefined : field)) ?? "undefined";
}

export interface PrefixMismatch {
	reason: string;
	/** Both serialized values from just before their first differing character, so the log shows what changed. */
	captured?: string;
	rebuilt?: string;
}

function difference(reason: string, captured: string, rebuilt: string): PrefixMismatch {
	let at = 0;
	while (at < captured.length && captured[at] === rebuilt[at]) at++;
	const from = Math.max(0, at - 40);
	return { reason, captured: captured.slice(from, at + 160), rebuilt: rebuilt.slice(from, at + 160) };
}

/** Where `rebuilt` stops matching the cache entry `captured` wrote, or undefined when it extends that request exactly. */
function prefixMismatch(captured: Payload, rebuilt: Payload, key: string, cacheNeutral: ReadonlySet<string>): PrefixMismatch | undefined {
	for (const field of new Set([...Object.keys(captured), ...Object.keys(rebuilt)])) {
		if (field === key || OUTPUT_LIMIT_KEYS.has(field) || cacheNeutral.has(field)) continue;
		const [before, after] = [canonical(captured[field]), canonical(rebuilt[field])];
		if (before !== after) return difference(`request field "${field}" differs`, before, after);
	}
	const before = captured[key] as unknown[];
	const after = rebuilt[key];
	if (!Array.isArray(after)) return { reason: `request has no "${key}" array` };
	let end = before.length;
	// The active effort rides at the end, after the cache breakpoint: Anthropic as trailing system entries,
	// OpenAI as a trailing configuration_update item. The next request moves it after the new turns.
	while (end > 0 && isTrailingEffort(before[end - 1])) end--;
	if (after.length <= end) return { reason: "request is shorter than the cached one" };
	for (let index = 0; index < end; index++) {
		const [was, now] = [canonical(before[index]), canonical(after[index])];
		if (was !== now) return difference(`message ${index} differs`, was, now);
	}
	return undefined;
}

function isTrailingEffort(item: unknown): boolean {
	return isPlainObject(item) && (item.role === "system" || item.type === "configuration_update");
}

/**
 * OpenAI's mixed cache lifetimes for GPT-5.6 and later: the system prompt, with the tool definitions
 * rendered before it, gets a 12-hour breakpoint, and the conversation keeps the 30-minute default.
 * `cacheKey` replaces Pi's per-session key, which keeps every new session from reading that prefix.
 * Only requests Pi already sends cache options are changed: Pi drops them when caching is off and on
 * endpoints that reject them, such as Sign in with ChatGPT.
 */
export function withSharedPrefixCache(payload: Payload, cacheKey: string): Payload {
	const input = payload.input;
	if (typeof payload.prompt_cache_key !== "string" || !isPlainObject(payload.prompt_cache_options) || !Array.isArray(input)) return payload;
	const [first, ...rest] = input;
	if (!isPlainObject(first) || first.role !== "developer" || typeof first.content !== "string") return payload;
	const content = [{ type: "input_text", text: first.content, prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } }];
	return { ...payload, prompt_cache_key: cacheKey, input: [{ ...first, content }, ...rest] };
}

/**
 * Kimi's 1-hour cache, for a request where Pi asked for its longer cache. Pi asks with OpenAI's prompt_cache_retention,
 * and Kimi takes the lifetime from prompt_cache_options instead. Pi leaves that field out when the request turns caching
 * off or the model's compat turns long retention off.
 */
export function withKimiLongCache(payload: Payload): Payload {
	if (payload.prompt_cache_retention !== "24h" || "prompt_cache_options" in payload) return payload;
	return { ...payload, prompt_cache_options: { mode: "implicit", ttl: "1h" } };
}

/**
 * The summary request's payload, built from Pi's `params` the way the agent's request was: with the shared prefix
 * key when `sharedKey` is set, and with the top-level fields only the captured request has, which extensions earlier
 * in the before_provider_request chain add (codex-fast adds service_tier) and the summary request skips. Returned only
 * when it extends the captured request's cache entry; otherwise, where it stops matching. Either way `sharedPrefix`
 * says whether the shared prefix key was applied. `cacheNeutral` names top-level fields the provider keeps out of the
 * cached prefix.
 */
export function summaryPayload(
	params: unknown,
	prefix: CachedPrefix,
	sharedKey: string | undefined,
	cacheNeutral: ReadonlySet<string>,
): { sharedPrefix: boolean } & ({ payload: Payload } | PrefixMismatch) {
	if (!isPlainObject(params)) return { reason: "the provider payload is not an object", sharedPrefix: false };
	const shared = sharedKey ? withSharedPrefixCache(params, sharedKey) : params;
	const sharedPrefix = shared !== params;
	const missing = Object.keys(prefix.payload).filter((field) => !(field in shared));
	const payload = { ...shared, ...Object.fromEntries(missing.map((field) => [field, prefix.payload[field]])) };
	const mismatch = prefixMismatch(prefix.payload, payload, prefix.key, cacheNeutral);
	return mismatch ? { ...mismatch, sharedPrefix } : { payload, sharedPrefix };
}

/** First words of a message as the model reads it, so the summary prompt can point at where the kept context starts. */
function messagePreview(message: Message): string | undefined {
	let text: string | undefined;
	if (message.role === "user") {
		text = contentText(message.content);
	} else if (message.role === "assistant") {
		text = message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : block.type === "toolCall" ? [`[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`] : []))
			.join("\n");
	}
	text = text?.trim();
	if (!text) return undefined;
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export interface KeptStart {
	text: string;
	/** Which of the kept messages opening with `text` it is, counting back from the end (1 for the last). */
	fromEnd: number;
	/** How many messages the request carries from the kept start on. */
	count: number;
}

/**
 * Where the messages Pi keeps verbatim start in `conversation`, the messages the summary request sends: the opening
 * of the first kept message it carries, as the model reads it. Undefined when there is none, or it has no text to
 * quote (an image or thinking only). Pi's cut can land on metadata entries just before that message, such as a
 * thinking change, and the request can lack kept messages that context handlers or `!!` commands keep from the model.
 */
export function keptStart(entries: SessionEntry[], firstKeptEntryId: string, conversation: AgentMessage[]): KeptStart | undefined {
	const projected = buildSessionProjection(entries).entries;
	const start = projected.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	if (start === -1) return undefined;
	const sent = conversation.filter((message) => convertToLlm([message]).length > 0);
	let at = -1;
	for (const message of projected.slice(start).flatMap((entry) => entry.messages)) {
		// The last match: a repeated custom message matched too early would leave messages unsummarized.
		at = sent.findLastIndex((candidate) => sameMessage(candidate, message));
		if (at !== -1) break;
	}
	if (at === -1) return undefined;
	const previews = convertToLlm(sent.slice(at)).map(messagePreview);
	const text = previews[0];
	return text ? { text, fromEnd: previews.filter((preview) => preview === text).length, count: previews.length } : undefined;
}

export function summaryInstruction(kept: KeptStart, customInstructions: string | undefined): string {
	const repeated = kept.fromEnd > 1 ? ` Several kept messages begin with this text: it is number ${kept.fromEnd} of them, counting back from the end.` : "";
	const toolCalls = kept.text.includes("[tool call: ") ? " Tool calls are written as [tool call: name arguments]." : "";
	const focus = customInstructions?.trim() ? `\n\nAdditional focus: ${customInstructions.trim()}` : "";
	return `Stop working on the task and do not call any tools. Write a structured context checkpoint summary of the earlier part of the conversation above. Another LLM will continue the work from your summary, followed by the last ${kept.count} messages of the conversation, which stay in context verbatim.

The kept messages start with the message that begins with the text below.${repeated}${toolCalls}

<kept-start>
${kept.text}
</kept-start>

Summarize only the messages before it, as if the conversation ended right there. Done lists only work finished before it. Whatever happens from that message on, including its tool calls, their results, and later replies, has not happened as far as your summary knows: leave it out, or list it under Next Steps if it was already planned.

If the conversation starts with an earlier summary, fold it into the new one: keep its facts, move finished items to Done, and update Next Steps.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages. Reply with the summary only, and stop it right before the message that begins with the <kept-start> text.${focus}`;
}

/**
 * The input tokens Pi's compaction would send for the same cut. It sends the summarized messages as text (tool output
 * cut to 2,000 characters) with the previous summary, plus a second request for the turn prefix when the cut splits a
 * turn, as compact() does. Nothing of it is read from the cache. Pi's 4 characters per token is off by up to a third
 * either way depending on the tokenizer and the content, so the count is scaled by how the provider counted `sent`,
 * the summary request's messages: `sentTokens` against Pi's estimate for them.
 */
export function piCompactionInput(
	{ messagesToSummarize, turnPrefixMessages, isSplitTurn, previousSummary }: SessionBeforeCompactEvent["preparation"],
	sent: AgentMessage[],
	sentTokens: number,
): number {
	const requestChars = (messages: AgentMessage[]) => serializeConversation(convertToLlm(messages)).length + PI_PROMPT_CHARS;
	const splitTurn = isSplitTurn && turnPrefixMessages.length > 0;
	let chars = splitTurn ? requestChars(turnPrefixMessages) : 0;
	if (!splitTurn || messagesToSummarize.length > 0) chars += requestChars(messagesToSummarize) + (previousSummary?.length ?? 0);
	const estimated = sent.reduce((sum, message) => sum + estimateTokens(message), 0);
	return Math.ceil((chars / 4) * (sentTokens / estimated));
}

/**
 * The compaction summary: the model's text followed by the read and modified file lists, merged with the lists this
 * extension's previous compaction stored in `details` (Pi carries lists forward only from its own compactions). The
 * model reads the previous summary in the conversation and can copy its lists, so lists in its text are replaced.
 */
export function checkpointSummary(text: string, fileOps: FileOperations, previousDetails: unknown): { summary: string; readFiles: string[]; modifiedFiles: string[] } {
	const read = new Set(fileOps.read);
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	if (isPlainObject(previousDetails)) {
		const { readFiles, modifiedFiles } = previousDetails;
		if (Array.isArray(readFiles)) for (const file of readFiles) if (typeof file === "string") read.add(file);
		if (Array.isArray(modifiedFiles)) for (const file of modifiedFiles) if (typeof file === "string") modified.add(file);
	}
	const readFiles = [...read].filter((file) => !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	const sections = [
		text.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "").trim(),
		readFiles.length > 0 ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
		modifiedFiles.length > 0 ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "",
	];
	return { summary: sections.filter(Boolean).join("\n\n"), readFiles, modifiedFiles };
}

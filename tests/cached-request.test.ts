import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { checkpointSummary, keptStart, summaryPayload, trailingMessages, withKimiLongCache, withSharedPrefixCache } from "../cached-request.ts";

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp }) as AgentMessage;
const entry = (id: string, message: AgentMessage) => ({ type: "message", id, parentId: null, timestamp: "", message }) as SessionEntry;
const none = new Set<string>();
const reason = (result: ReturnType<typeof summaryPayload>) => ("reason" in result ? result.reason : undefined);

test("a summary request that only appends turns and moves the cache breakpoint is sent as Pi built it", () => {
	const captured = {
		model: "m",
		system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
		max_tokens: 100,
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
			{ role: "system", content: [], output_config: { effort: "high" } },
		],
	};
	const rebuilt = {
		...captured,
		max_tokens: 90,
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: [{ type: "text", text: "summarize", cache_control: { type: "ephemeral" } }] },
		],
	};
	assert.deepEqual(summaryPayload(rebuilt, { payload: captured, key: "messages" }, undefined, none), { payload: rebuilt, sharedPrefix: false });
});

test("a changed message or request field is reported with the text around the change, and nothing is sent", () => {
	const prefix = { payload: { model: "m", messages: [{ role: "user", content: "hi" }] }, key: "messages" };
	assert.deepEqual(
		summaryPayload({ model: "m", messages: [{ role: "user", content: "edited" }, { role: "user", content: "x" }] }, prefix, undefined, none),
		{ reason: "message 0 differs", captured: '{"role":"user","content":"hi"}', rebuilt: '{"role":"user","content":"edited"}', sharedPrefix: false },
	);
	assert.deepEqual(
		summaryPayload({ model: "other", messages: [...prefix.payload.messages, { role: "user", content: "x" }] }, prefix, undefined, none),
		{ reason: 'request field "model" differs', captured: '"m"', rebuilt: '"other"', sharedPrefix: false },
	);
	assert.deepEqual(summaryPayload("not a payload", prefix, undefined, none), { reason: "the provider payload is not an object", sharedPrefix: false });
});

test("trailing messages are the branch entries after the captured transcript", () => {
	const prompt = user("fix the bug", 1);
	const reply = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 } as AgentMessage;
	const entries = [
		entry("a", prompt),
		{ type: "label", id: "l", parentId: "a", timestamp: "", targetId: "a", label: "x" } as SessionEntry,
		entry("b", reply),
	];
	assert.deepEqual(trailingMessages(entries, [prompt]), { messages: [reply] });
});

test("extension messages after the captured request are trailing, and one that ended it is found by its content and stamp", () => {
	const notice = (id: string, text: string, at: string) =>
		({ type: "custom_message", id, parentId: null, timestamp: at, customType: "subagent-notify", content: text, display: true }) as SessionEntry;
	const reply = { role: "assistant", content: [{ type: "text", text: "noted" }], timestamp: Date.parse("2026-10-21T10:00:06.000Z") } as AgentMessage;
	const entries = [entry("u", user("go", 1)), notice("c1", "run done", "2026-10-21T10:00:05.000Z"), entry("a", reply), notice("c2", "run done", "2026-10-21T10:00:09.000Z")];
	// The request carried the first notice as sent, before Pi stamped its entry; an identical one came later.
	const sent = { role: "custom", customType: "subagent-notify", content: "run done", display: true, timestamp: Date.parse("2026-10-21T10:00:04.000Z") } as AgentMessage;
	const result = trailingMessages(entries, [user("go", 1), sent]);
	assert.ok("messages" in result, JSON.stringify(result));
	assert.deepEqual(result.messages.map((message) => message.role), ["assistant", "custom"]);
});

test("fields an earlier extension added to the agent's request are sent with the summary request", () => {
	const captured = { model: "gpt", service_tier: "priority", input: [{ role: "user", content: "hi" }] };
	const input = [...captured.input, { role: "user", content: "summarize" }];
	assert.deepEqual(summaryPayload({ model: "gpt", input }, { payload: captured, key: "input" }, undefined, none), {
		payload: { model: "gpt", service_tier: "priority", input },
		sharedPrefix: false,
	});
});

test("a GPT summary request gets the project's 12-hour prefix before it is compared with the agent's request", () => {
	const options = { ttl: "30m" };
	const turn = { role: "user", content: [{ type: "input_text", text: "fix the bug" }] };
	const summarize = { role: "user", content: [{ type: "input_text", text: "summarize" }] };
	const developer = { role: "developer", content: [{ type: "input_text", text: "You are Pi.", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } }] };
	const captured = { model: "gpt-6-luna", prompt_cache_key: "pi-project", prompt_cache_options: options, input: [developer, turn] };
	const rebuilt = { model: "gpt-6-luna", prompt_cache_key: "session-1", prompt_cache_options: options, input: [{ role: "developer", content: "You are Pi." }, turn, summarize] };
	const prefix = { payload: captured, key: "input" };
	assert.deepEqual(summaryPayload(rebuilt, prefix, "pi-project", none), {
		payload: { ...captured, input: [developer, turn, summarize] },
		sharedPrefix: true,
	});
	assert.equal(reason(summaryPayload(rebuilt, prefix, undefined, none)), 'request field "prompt_cache_key" differs');
	// The card shows the shared prefix on a request that was not sent too, so a mismatch it caused can be told apart.
	const edited = { ...rebuilt, input: [{ role: "developer", content: "You are Pi, edited." }, turn, summarize] };
	assert.equal(summaryPayload(edited, prefix, "pi-project", none).sharedPrefix, true);
});

test("the kept start is the first kept message the request carries, with tool calls quoted and repeats counted from the end", () => {
	const call = (timestamp: number) =>
		({ role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "toolCall", id: `t${timestamp}`, name: "bash", arguments: { command: "ls" } }], timestamp }) as AgentMessage;
	const entries = [
		{ type: "thinking_level_change", id: "k", parentId: null, timestamp: "", thinkingLevel: "high" } as SessionEntry,
		{ ...entry("a1", call(1)), parentId: "k" } as SessionEntry,
		{ ...entry("a2", call(2)), parentId: "a1" } as SessionEntry,
	];
	assert.deepEqual(keptStart(entries, "k", [user("start", 0), call(1), call(2)]), { text: '[tool call: bash {"command":"ls"}]', fromEnd: 2, count: 2 });
	// A `!!` command is kept in the session but never sent to the model.
	const hidden = { role: "bashExecution", command: "git status", output: "", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 4 } as AgentMessage;
	const afterHidden = [entry("b", hidden), { ...entry("n", user("next", 5)), parentId: "b" } as SessionEntry];
	assert.deepEqual(keptStart(afterHidden, "b", [hidden, user("next", 5)]), { text: "next", fromEnd: 1, count: 1 });
	const thinkingOnly = { role: "assistant", content: [{ type: "thinking", thinking: "..." }], timestamp: 3 } as AgentMessage;
	assert.equal(keptStart([entry("a3", thinkingOnly)], "a3", [thinkingOnly]), undefined);
});

test("a field the provider keeps out of the cached prefix may differ only when named", () => {
	const captured = { model: "gpt", tool_choice: "auto", input: [{ role: "user", content: "hi" }] };
	const rebuilt = { ...captured, tool_choice: "none", input: [...captured.input, { role: "user", content: "summarize" }] };
	const toolChoice = new Set(["tool_choice"]);
	assert.equal(reason(summaryPayload(rebuilt, { payload: captured, key: "input" }, undefined, none)), 'request field "tool_choice" differs');
	assert.deepEqual(summaryPayload(rebuilt, { payload: captured, key: "input" }, undefined, toolChoice), { payload: rebuilt, sharedPrefix: false });
	// OpenAI's active reasoning effort trails the cache breakpoint and moves after the new turns.
	const withEffort = { ...captured, input: [...captured.input, { type: "configuration_update", reasoning: { effort: "high" } }] };
	assert.deepEqual(summaryPayload(rebuilt, { payload: withEffort, key: "input" }, undefined, toolChoice), { payload: rebuilt, sharedPrefix: false });
});

test("a branch that no longer contains the captured transcript is rejected", () => {
	assert.deepEqual(trailingMessages([entry("a", user("other branch", 5))], [user("fix the bug", 1)]), { reason: "its last message is no longer on this branch" });
	const withSummary = [
		entry("a", user("fix the bug", 1)),
		{ type: "branch_summary", id: "s", parentId: "a", timestamp: "", summary: "...", fromId: "x" } as SessionEntry,
	];
	assert.deepEqual(trailingMessages(withSummary, [user("fix the bug", 1)]), { reason: "a branch_summary entry came after it" });
});

test("a compaction entry the captured request already summarizes does not end the trailing messages", () => {
	// Mid-run compaction: the entry lands after the tool result, and the next request starts with its summary.
	const toolResult = user("tool output", 2);
	const call = { role: "assistant", content: [{ type: "text", text: "edit" }], timestamp: 4 } as AgentMessage;
	const compaction = (at: number) => ({ type: "compaction", id: `c${at}`, parentId: null, timestamp: new Date(at).toISOString(), summary: "s", firstKeptEntryId: "a", tokensBefore: 1 }) as SessionEntry;
	const entries = [entry("a", user("fix the bug", 1)), entry("b", toolResult), compaction(3), entry("d", call)];
	const summary = { role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp: 3 } as AgentMessage;
	assert.deepEqual(trailingMessages(entries, [summary, user("fix the bug", 1), toolResult]), { messages: [call] });
	// A request sent before that compaction does not carry its summary.
	assert.deepEqual(trailingMessages(entries, [user("fix the bug", 1), toolResult]), { reason: "a compaction entry came after it" });
});

test("GPT long retention caches the system prompt for 12 hours under the project's key", () => {
	const turn = { role: "user", content: [{ type: "input_text", text: "fix the bug" }] };
	const options = { ttl: "30m" };
	const request = { model: "gpt-6-luna", prompt_cache_key: "session-1", prompt_cache_options: options, input: [{ role: "developer", content: "You are Pi." }, turn] };
	assert.deepEqual(withSharedPrefixCache(request, "pi-project"), {
		model: "gpt-6-luna",
		prompt_cache_key: "pi-project",
		prompt_cache_options: options,
		input: [{ role: "developer", content: [{ type: "input_text", text: "You are Pi.", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } }] }, turn],
	});
	// Pi drops the key when a request turns caching off, as its own compaction does.
	const uncached = { model: "gpt-6-luna", input: request.input };
	assert.equal(withSharedPrefixCache(uncached, "pi-project"), uncached);
	// Pi keeps the key but drops the cache options for endpoints that reject them, such as Sign in with ChatGPT.
	const noOptions = { model: "gpt-6-luna", prompt_cache_key: "session-1", input: request.input };
	assert.equal(withSharedPrefixCache(noOptions, "pi-project"), noOptions);
});

test("a Kimi request gets the 1-hour cache option only when Pi asked for its longer cache", () => {
	const messages = [{ role: "user", content: "hi" }];
	assert.deepEqual(withKimiLongCache({ model: "kimi-k3", messages, prompt_cache_retention: "24h" }), {
		model: "kimi-k3",
		messages,
		prompt_cache_retention: "24h",
		prompt_cache_options: { mode: "implicit", ttl: "1h" },
	});
	const short = { model: "kimi-k3", messages };
	assert.equal(withKimiLongCache(short), short);
});

test("the summary ends with one set of file lists, merged with the previous compaction's, even when the model copied the old ones", () => {
	const text = "## Goal\nEdit notes.\n\n<modified-files>\nold.txt\n</modified-files>";
	const fileOps = { read: new Set(["a.ts", "notes.txt"]), written: new Set<string>(), edited: new Set(["notes.txt"]) };
	const checkpoint = checkpointSummary(text, fileOps, { readFiles: ["b.ts"], modifiedFiles: ["old.txt"] });

	assert.equal(checkpoint.summary, "## Goal\nEdit notes.\n\n<read-files>\na.ts\nb.ts\n</read-files>\n\n<modified-files>\nnotes.txt\nold.txt\n</modified-files>");
	assert.deepEqual(checkpoint.readFiles, ["a.ts", "b.ts"]);
	assert.deepEqual(checkpoint.modifiedFiles, ["notes.txt", "old.txt"]);
});

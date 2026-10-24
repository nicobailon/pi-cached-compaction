import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cacheState } from "../cache-state.ts";

const claude = { provider: "anthropic", id: "claude", api: "anthropic-messages" } as Model<Api>;
const reply = (id: string, timestamp: number, usage: { cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }, stopReason = "stop") =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "",
		message: { role: "assistant", content: [], timestamp, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, ...usage } },
	}) as unknown as SessionEntry;
const compaction = { type: "compaction", id: "c", parentId: null, timestamp: "" } as SessionEntry;

test("the cache expires a lifetime after the latest cached request or cache-warming refresh, and resets at compaction", () => {
	const declared = { ...claude, promptCache: { short: 300, long: 300 } } as Model<Api>;
	const warm = { type: "usage", id: "w", parentId: null, timestamp: new Date(200_000).toISOString(), kind: "cache_warm" } as SessionEntry;
	const cached = reply("a", 1_000, { cacheRead: 500 });

	assert.deepEqual(cacheState(declared, [cached]), { lifetime: { ms: 300_000, source: "declared by the model" }, cached: true, expiresAt: 301_000, replied: true });
	assert.equal(cacheState(declared, [cached, warm]).expiresAt, 500_000);
	assert.deepEqual(cacheState(declared, [reply("a", 1_000, {})]), { lifetime: { ms: 300_000, source: "declared by the model" }, cached: false, expiresAt: undefined, replied: true });
	assert.equal(cacheState(declared, [cached, reply("b", 9_000, {}, "error")]).expiresAt, 301_000);
	assert.deepEqual(cacheState(declared, [cached, compaction]), { lifetime: { ms: 300_000, source: "declared by the model" }, cached: false, expiresAt: undefined, replied: false });
});

test("the lifetime is the tier the latest write reported, the model's figure for that tier, or OpenAI's minimum", () => {
	const lifetime = (model: Model<Api>, entries: SessionEntry[]) => cacheState(model, entries).lifetime;
	const long = reply("a", 1, { cacheWrite: 500, cacheWrite1h: 500 });

	assert.deepEqual(lifetime(claude, [long]), { ms: 3_600_000, source: "reported by the provider" });
	assert.deepEqual(lifetime(claude, [long, reply("b", 2, { cacheWrite: 40, cacheWrite1h: 0 })]), { ms: 300_000, source: "reported by the provider" });
	assert.deepEqual(lifetime(claude, [long, reply("b", 2, { cacheRead: 500 })]), { ms: 3_600_000, source: "reported by the provider" }, "a turn that only read keeps the tier");
	assert.deepEqual(cacheState(claude, [reply("a", 1, { cacheWrite: 500 })]), { lifetime: undefined, cached: true, expiresAt: undefined, replied: true });
	assert.deepEqual(lifetime(claude, [reply("a", 1, { cacheWrite: 500, cacheWrite1h: 500 }, "error")]), { ms: 3_600_000, source: "reported by the provider" }, "a failed turn still reports the tier it wrote");
	assert.equal(lifetime(claude, [long, compaction]), undefined);
	const declared = { ...claude, promptCache: { short: 60, long: 7200 } } as Model<Api>;
	assert.deepEqual(lifetime(declared, [long]), { ms: 7_200_000, source: "declared by the model" });
	const gpt = { provider: "openai", id: "gpt-6-luna", api: "openai-responses", compat: { supportsExplicitPromptCacheMode: true } } as Model<Api>;
	assert.deepEqual(lifetime(gpt, [reply("a", 1, { cacheRead: 500 })]), { ms: 1_800_000, source: "OpenAI's minimum" });
});

test("Kimi K3 on Moonshot's API caches for 5 minutes, or 1 hour when Pi asks for the longer cache", () => {
	const lifetime = (model: object) => cacheState(model as Model<Api>, [reply("a", 1, { cacheRead: 500 })]).lifetime;
	const kimi = { provider: "moonshotai", id: "kimi-k3", api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1" };
	const before = process.env.PI_CACHE_RETENTION;
	try {
		delete process.env.PI_CACHE_RETENTION;
		assert.deepEqual(lifetime(kimi), { ms: 300_000, source: "Kimi's default" });
		process.env.PI_CACHE_RETENTION = "long";
		assert.deepEqual(lifetime(kimi), { ms: 3_600_000, source: "Kimi's 1-hour option" });
		assert.deepEqual(lifetime({ ...kimi, compat: { supportsLongCacheRetention: false } }), { ms: 300_000, source: "Kimi's default" });
		assert.equal(lifetime({ ...kimi, id: "kimi-k2.6" }), undefined);
		assert.equal(lifetime({ ...kimi, provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" }), undefined);
	} finally {
		if (before === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = before;
	}
});

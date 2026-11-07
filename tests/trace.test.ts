import assert from "node:assert/strict";
import test from "node:test";
import { comparison, describeTrace, type CompactTrace, type TraceUsage } from "../trace.ts";

const cached = (usage: Partial<TraceUsage>, piEstimate: CompactTrace["piEstimate"]): CompactTrace => ({
	event: "compact",
	trigger: "manual",
	model: "m",
	outcome: "cached",
	tokensBefore: 0,
	cwd: "/",
	response: { stopReason: "stop", seconds: 1, summaryChars: 1, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, ...usage } },
	piEstimate,
});

test("the card compares a cached compaction with Pi's: by cost when the model has prices, else by tokens not read from the cache", () => {
	assert.equal(
		comparison(cached({ cost: 0.061 }, { input: 186_000, cost: 0.47 }))?.text,
		"vs Pi's compaction: 87% less, $0.061 instead of ~$0.47 (it sends ~186k tokens, none from cache)",
	);
	assert.equal(
		comparison(cached({ input: 2, cacheRead: 39_559, cacheWrite: 457_879 }, { input: 186_000, cost: 0 }))?.text,
		"vs Pi's compaction: 2.5× as much, 458k tokens not from cache instead of ~186k",
	);
});

test("the log describes compacting when full", () => {
	const at = "2026-11-08T10:00:00.000Z";
	const time = new Date(at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	const base = { event: "full" as const, contextTokens: 905_000, threshold: 900_000, percent: 90, at, session: "s" };
	assert.equal(describeTrace({ ...base, action: "compact" }), `${time} context at 905k, past 90% (900k): compacting`);
	assert.equal(describeTrace({ ...base, action: "skip", reason: "Pi is busy or has queued messages" }), `${time} context at 905k, past 90% (900k): not compacting, Pi is busy or has queued messages`);
});

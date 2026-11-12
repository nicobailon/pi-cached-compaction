import assert from "node:assert/strict";
import test from "node:test";
import { comparison, formatCacheStatus, formatRemaining, type CompactTrace, type TraceUsage } from "../trace.ts";

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

test("the footer labels the countdown as the cache's, and the /cached-compaction line keeps the bare time", () => {
	assert.equal(formatCacheStatus(59 * 60_000), "cache 59m");
	assert.equal(formatCacheStatus(120_000), "cache 2m");
	assert.equal(formatCacheStatus(25_000), "cache 0:25");
	assert.equal(formatCacheStatus(400), "cache 0:01");
	assert.equal(formatCacheStatus(0), "cache cold");
	assert.equal(formatCacheStatus(-5_000), "cache cold");
	assert.equal(formatRemaining(29 * 60_000), "29m");
	assert.equal(formatRemaining(25_000), "0:25");
});

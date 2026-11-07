import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoCompactionEnabled, fullThreshold, loadConfig, saveConfig, summaryBudget } from "../config.ts";

test("settings: compacting before expiry is on by default, a byte-order mark is allowed, unknown keys fail, and Pi's compaction switch is read project over global", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	const project = join(dir, "project");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(loadConfig().compactBeforeExpiry, true);
		writeFileSync(settings, String.fromCharCode(0xfeff) + JSON.stringify({ cachedCompaction: { compactBeforeExpiry: false }, compaction: { enabled: false } }));
		assert.equal(loadConfig().compactBeforeExpiry, false);
		assert.equal(autoCompactionEnabled(undefined), false);
		writeFileSync(settings, JSON.stringify({ cachedCompaction: { compactBeforeExpiryy: true } }));
		assert.throws(loadConfig, /unknown keys: compactBeforeExpiryy/);
		assert.equal(autoCompactionEnabled(undefined), true);
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		assert.equal(autoCompactionEnabled(project), false);
		writeFileSync(settings, JSON.stringify({ compaction: { enabled: false } }));
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
		assert.equal(autoCompactionEnabled(project), true);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

test("settings: compacting when full is on at 90% by default, takes a whole percentage or 0, and saving keeps every other setting", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));
	const settings = join(dir, "settings.json");
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.equal(loadConfig().compactAtPercent, 90);
		for (const bad of [100, -1, 85.5, "90"]) {
			writeFileSync(settings, JSON.stringify({ cachedCompaction: { compactAtPercent: bad } }));
			assert.throws(loadConfig, /compactAtPercent .* whole percentage/);
		}
		writeFileSync(settings, JSON.stringify({ theme: "dark", compaction: { enabled: true }, cachedCompaction: { minContextTokens: 200_000 } }));
		const saved = saveConfig({ compactAtPercent: 80, cacheRetention: "short" });
		assert.deepEqual(saved, { cacheRetention: "short", compactBeforeExpiry: true, minContextTokens: 200_000, compactAtPercent: 80 });
		assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), {
			theme: "dark",
			compaction: { enabled: true },
			cachedCompaction: { minContextTokens: 200_000, compactAtPercent: 80, cacheRetention: "short" },
		});
		assert.equal(saveConfig({ compactAtPercent: 0 }).compactAtPercent, 0);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(dir, { recursive: true });
	}
});

test("a summary may use the model's output limit, reduced so prompt and summary fit the window; when full starts at the given share of the window", () => {
	const opus = { contextWindow: 1_000_000, maxTokens: 128_000 };
	// 2026-11-07: a 984k-token session had ~12k left, too little; at 90% a summary has ~96k.
	assert.equal(summaryBudget(opus, 984_000), 12_000);
	assert.equal(summaryBudget(opus, 900_000), 96_000);
	assert.equal(summaryBudget(opus, 200_000), 128_000);
	assert.equal(summaryBudget(opus, 1_200_000), 0);
	assert.equal(summaryBudget({ contextWindow: 0, maxTokens: 32_000 }, 500_000), 32_000);
	assert.equal(summaryBudget({ contextWindow: 0, maxTokens: 0 }, 500_000), undefined);
	assert.equal(fullThreshold(opus, 90), 900_000);
	assert.equal(fullThreshold({ contextWindow: 272_000, maxTokens: 128_000 }, 85), 231_200);
	assert.equal(fullThreshold(opus, 0), undefined);
	assert.equal(fullThreshold({ contextWindow: 0, maxTokens: 128_000 }, 90), undefined);
});

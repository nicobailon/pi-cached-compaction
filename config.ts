import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isPlainObject } from "./cached-request.ts";

export interface CachedCompactionConfig {
	cacheRetention: "short" | "long";
	compactBeforeExpiry: boolean;
	minContextTokens: number;
	/** Compact once the context fills this share of the model's window, 0 = off. */
	compactAtPercent: number;
}

const DEFAULTS: CachedCompactionConfig = { cacheRetention: "long", compactBeforeExpiry: true, minContextTokens: 140_000, compactAtPercent: 90 };

/** The values `/cached-compaction settings` offers for compactAtPercent; 0 is "off". */
export const COMPACT_AT_PERCENTS = [0, 50, 60, 70, 75, 80, 85, 90, 95];
/** The values `/cached-compaction settings` offers for minContextTokens. */
export const MIN_CONTEXT_CHOICES = [50_000, 100_000, 140_000, 200_000, 300_000, 500_000];
/** A cached summary request needs at least this many output tokens; with less room, Pi's compaction runs instead. */
export const MIN_SUMMARY_TOKENS = 16_000;
/** Room kept free for the summary instruction and token-count drift between Pi's estimate and the provider's count. */
const PROMPT_MARGIN_TOKENS = 4_000;

const settingsPath = () => join(getAgentDir(), "settings.json");

function readSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function loadConfig(): CachedCompactionConfig {
	const path = settingsPath();
	const raw: unknown = readSettings(path).cachedCompaction;
	if (raw === undefined) return DEFAULTS;
	if (!isPlainObject(raw)) throw new Error(`cachedCompaction in ${path} must be an object`);
	const unknown = Object.keys(raw).filter((key) => !(key in DEFAULTS));
	if (unknown.length > 0) throw new Error(`cachedCompaction in ${path} has unknown keys: ${unknown.join(", ")}`);
	const {
		cacheRetention = DEFAULTS.cacheRetention,
		compactBeforeExpiry = DEFAULTS.compactBeforeExpiry,
		minContextTokens = DEFAULTS.minContextTokens,
		compactAtPercent = DEFAULTS.compactAtPercent,
	} = raw;
	if (cacheRetention !== "short" && cacheRetention !== "long") throw new Error(`cachedCompaction.cacheRetention in ${path} must be "short" or "long"`);
	if (typeof compactBeforeExpiry !== "boolean") throw new Error(`cachedCompaction.compactBeforeExpiry in ${path} must be true or false`);
	if (typeof minContextTokens !== "number" || !Number.isInteger(minContextTokens) || minContextTokens < 0) {
		throw new Error(`cachedCompaction.minContextTokens in ${path} must be a whole number of tokens`);
	}
	if (typeof compactAtPercent !== "number" || !Number.isInteger(compactAtPercent) || compactAtPercent < 0 || compactAtPercent > 99) {
		throw new Error(`cachedCompaction.compactAtPercent in ${path} must be a whole percentage from 1 to 99, or 0 for off`);
	}
	return { cacheRetention, compactBeforeExpiry, minContextTokens, compactAtPercent };
}

/** Writes the given keys into `cachedCompaction` in the global settings file, keeping every other setting, and returns the new config. */
export function saveConfig(patch: Partial<CachedCompactionConfig>): CachedCompactionConfig {
	const path = settingsPath();
	const settings = readSettings(path);
	const current = isPlainObject(settings.cachedCompaction) ? settings.cachedCompaction : {};
	settings.cachedCompaction = { ...current, ...patch };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	return loadConfig();
}

export function autoCompactionEnabled(trustedProjectDir: string | undefined): boolean {
	const enabled = (path: string) => (readSettings(path).compaction as { enabled?: unknown } | undefined)?.enabled;
	const project = trustedProjectDir === undefined ? undefined : enabled(join(trustedProjectDir, CONFIG_DIR_NAME, "settings.json"));
	return (project ?? enabled(settingsPath())) !== false;
}

interface WindowedModel {
	contextWindow: number;
	maxTokens: number;
}

/**
 * Output tokens a summary request may use: the model's output limit, reduced so the prompt and the summary fit the
 * context window (as Pi's own compaction does). Undefined when the model declares neither limit.
 */
export function summaryBudget(model: WindowedModel, promptTokens: number): number | undefined {
	const cap = model.maxTokens > 0 ? model.maxTokens : Infinity;
	const room = model.contextWindow > 0 ? model.contextWindow - promptTokens - PROMPT_MARGIN_TOKENS : Infinity;
	const budget = Math.min(cap, room);
	return Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : undefined;
}

/** The context size at which compacting "when full" starts, or undefined when it is off or the window is unknown. */
export function fullThreshold(model: WindowedModel, percent: number): number | undefined {
	if (percent <= 0 || model.contextWindow <= 0) return undefined;
	return Math.floor((model.contextWindow * percent) / 100);
}

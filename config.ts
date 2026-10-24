import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CachedCompactionConfig {
	/**
	 * "long" asks providers for their longer cache lifetime in interactive sessions: 1 hour on Anthropic, 24 hours on
	 * OpenAI models before GPT-5.6. GPT-5.6 and later keep their 30-minute conversation cache and get a 12-hour system
	 * prompt cache shared by the project's sessions. Claude Code picks its own on pi-claude.
	 */
	cacheRetention: "short" | "long";
	compactBeforeExpiry: boolean;
	minContextTokens: number;
}

const DEFAULTS: CachedCompactionConfig = { cacheRetention: "long", compactBeforeExpiry: true, minContextTokens: 140_000 };

const settingsPath = () => join(getAgentDir(), "settings.json");

/** The global Pi settings file, parsed the way Pi parses it (a leading byte-order mark is allowed). */
function readSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** Reads the `cachedCompaction` key of the global Pi settings file. Invalid values and unknown keys fail loudly. */
export function loadConfig(): CachedCompactionConfig {
	const path = settingsPath();
	const raw: unknown = readSettings(path).cachedCompaction;
	if (raw === undefined) return DEFAULTS;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`cachedCompaction in ${path} must be an object`);
	const unknown = Object.keys(raw).filter((key) => !(key in DEFAULTS));
	if (unknown.length > 0) throw new Error(`cachedCompaction in ${path} has unknown keys: ${unknown.join(", ")}`);
	const { cacheRetention = DEFAULTS.cacheRetention, compactBeforeExpiry = DEFAULTS.compactBeforeExpiry, minContextTokens = DEFAULTS.minContextTokens } =
		raw as Record<string, unknown>;
	if (cacheRetention !== "short" && cacheRetention !== "long") throw new Error(`cachedCompaction.cacheRetention in ${path} must be "short" or "long"`);
	if (typeof compactBeforeExpiry !== "boolean") throw new Error(`cachedCompaction.compactBeforeExpiry in ${path} must be true or false`);
	if (typeof minContextTokens !== "number" || !Number.isInteger(minContextTokens) || minContextTokens < 0) {
		throw new Error(`cachedCompaction.minContextTokens in ${path} must be a whole number of tokens`);
	}
	return { cacheRetention, compactBeforeExpiry, minContextTokens };
}

/**
 * Pi's automatic compaction switch (`compaction.enabled`), from a trusted project's settings over the global ones as
 * Pi merges them. Read when needed, because Pi's settings change it mid-session.
 */
export function autoCompactionEnabled(trustedProjectDir: string | undefined): boolean {
	const enabled = (path: string) => (readSettings(path).compaction as { enabled?: unknown } | undefined)?.enabled;
	const project = trustedProjectDir === undefined ? undefined : enabled(join(trustedProjectDir, CONFIG_DIR_NAME, "settings.json"));
	return (project ?? enabled(settingsPath())) !== false;
}

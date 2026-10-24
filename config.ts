import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isPlainObject } from "./cached-request.ts";

export interface CachedCompactionConfig {
	cacheRetention: "short" | "long";
	compactBeforeExpiry: boolean;
	minContextTokens: number;
}

const DEFAULTS: CachedCompactionConfig = { cacheRetention: "long", compactBeforeExpiry: true, minContextTokens: 140_000 };

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
	const { cacheRetention = DEFAULTS.cacheRetention, compactBeforeExpiry = DEFAULTS.compactBeforeExpiry, minContextTokens = DEFAULTS.minContextTokens } = raw;
	if (cacheRetention !== "short" && cacheRetention !== "long") throw new Error(`cachedCompaction.cacheRetention in ${path} must be "short" or "long"`);
	if (typeof compactBeforeExpiry !== "boolean") throw new Error(`cachedCompaction.compactBeforeExpiry in ${path} must be true or false`);
	if (typeof minContextTokens !== "number" || !Number.isInteger(minContextTokens) || minContextTokens < 0) {
		throw new Error(`cachedCompaction.minContextTokens in ${path} must be a whole number of tokens`);
	}
	return { cacheRetention, compactBeforeExpiry, minContextTokens };
}

export function autoCompactionEnabled(trustedProjectDir: string | undefined): boolean {
	const enabled = (path: string) => (readSettings(path).compaction as { enabled?: unknown } | undefined)?.enabled;
	const project = trustedProjectDir === undefined ? undefined : enabled(join(trustedProjectDir, CONFIG_DIR_NAME, "settings.json"));
	return (project ?? enabled(settingsPath())) !== false;
}

import type { Api, Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const REPORTED_TIER_SECONDS = { short: 300, long: 3600 } as const;
const OPENAI_MIN_LIFETIME_SECONDS = 1800;
const KIMI_TTL_SECONDS = { short: 300, long: 3600 } as const;

export function hasExplicitPromptCache(model: Model<Api>): boolean {
	return model.api === "openai-responses" && (model.compat as OpenAIResponsesCompat | undefined)?.supportsExplicitPromptCacheMode === true;
}

export function isKimiOnMoonshot(model: Model<Api>): boolean {
	return model.api === "openai-completions" && /^https:\/\/api\.moonshot\.(ai|cn)\//.test(model.baseUrl) && model.id.startsWith("kimi-k3");
}

export interface CacheState {
	lifetime?: { ms: number; source: string };
	cached: boolean;
	expiresAt?: number;
	replied: boolean;
}

export function cacheState(model: Model<Api>, entries: SessionEntry[]): CacheState {
	let refreshedAt: number | undefined;
	let reported: "short" | "long" | undefined;
	let replied = false;
	for (const entry of entries) {
		if (entry.type === "compaction") {
			refreshedAt = reported = undefined;
			replied = false;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			const { cacheRead, cacheWrite, cacheWrite1h } = entry.message.usage;
			if (cacheWrite > 0 && cacheWrite1h !== undefined) reported = cacheWrite1h > 0 ? "long" : "short";
			// A failed request may not have reached the cache.
			if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
			replied = true;
			refreshedAt = cacheRead + cacheWrite > 0 ? entry.message.timestamp : undefined;
		} else if (entry.type === "usage" && entry.kind === "cache_warm" && refreshedAt !== undefined) {
			refreshedAt = Math.max(refreshedAt, Date.parse(entry.timestamp));
		}
	}
	const declared = model.promptCache?.[reported ?? (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short")];
	let lifetime: CacheState["lifetime"];
	if (declared !== undefined) lifetime = { ms: declared * 1000, source: "declared by the model" };
	else if (reported) lifetime = { ms: REPORTED_TIER_SECONDS[reported] * 1000, source: "reported by the provider" };
	else if (hasExplicitPromptCache(model)) lifetime = { ms: OPENAI_MIN_LIFETIME_SECONDS * 1000, source: "OpenAI's minimum" };
	else if (isKimiOnMoonshot(model)) {
		const long = process.env.PI_CACHE_RETENTION === "long" && (model.compat as OpenAICompletionsCompat | undefined)?.supportsLongCacheRetention !== false;
		lifetime = { ms: KIMI_TTL_SECONDS[long ? "long" : "short"] * 1000, source: long ? "Kimi's 1-hour option" : "Kimi's default" };
	}
	const expiresAt = lifetime && refreshedAt !== undefined ? refreshedAt + lifetime.ms : undefined;
	return { lifetime, cached: refreshedAt !== undefined, expiresAt, replied };
}

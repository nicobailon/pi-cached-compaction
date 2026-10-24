import type { Api, Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Anthropic's cache lifetimes, for a provider that reports the tier it wrote but declares no lifetime (the Claude bridge). */
const REPORTED_TIER_SECONDS = { short: 300, long: 3600 } as const;
/**
 * OpenAI's guaranteed minimum cache lifetime on GPT-5.6 and later. Pi requests it for both retention settings and
 * never sends the 12-hour tier itself; this extension adds one for the system prompt only. Earlier GPT models only
 * state a typical lifetime.
 */
const OPENAI_MIN_LIFETIME_SECONDS = 1800;
/** Kimi K3's cache lifetimes: 5 minutes by default, 1 hour when the request's prompt_cache_options asks for it. */
const KIMI_TTL_SECONDS = { short: 300, long: 3600 } as const;

/** GPT-5.6 and later: Pi sends them prompt_cache_options, and OpenAI keeps their cache at least 30 minutes. */
export function hasExplicitPromptCache(model: Model<Api>): boolean {
	return model.api === "openai-responses" && (model.compat as OpenAIResponsesCompat | undefined)?.supportsExplicitPromptCacheMode === true;
}

/** Kimi K3 models on Moonshot's own API, which choose their cache lifetime with prompt_cache_options. */
export function isKimiOnMoonshot(model: Model<Api>): boolean {
	return model.api === "openai-completions" && /^https:\/\/api\.moonshot\.(ai|cn)\//.test(model.baseUrl) && model.id.startsWith("kimi-k3");
}

export interface CacheState {
	/** How long the conversation's cache lives, and where that figure comes from. Undefined when nothing gives one. */
	lifetime?: { ms: number; source: string };
	/** Whether the latest request since the last compaction read or wrote the cache. */
	cached: boolean;
	/** When that cache expires; undefined without a cached request or a known lifetime. */
	expiresAt?: number;
	/** Whether any request since the last compaction got a reply. */
	replied: boolean;
}

/**
 * The prompt cache of the branch's conversation since its last compaction. The lifetime is the tier the latest
 * cache write reported (Pi's Anthropic provider and the Claude bridge give its 1-hour share as `cacheWrite1h`),
 * else the tier PI_CACHE_RETENTION asks for. Pi's cache warmer records each refresh as a usage entry.
 */
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
			// A failed request may never have reached the cache, so it neither refreshes nor clears it.
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
		// Pi asks for the longer cache only where the model's compat allows it, and the request then gets Kimi's 1-hour option.
		const long = process.env.PI_CACHE_RETENTION === "long" && (model.compat as OpenAICompletionsCompat | undefined)?.supportsLongCacheRetention !== false;
		lifetime = { ms: KIMI_TTL_SECONDS[long ? "long" : "short"] * 1000, source: long ? "Kimi's 1-hour option" : "Kimi's default" };
	}
	const expiresAt = lifetime && refreshedAt !== undefined ? refreshedAt + lifetime.ms : undefined;
	return { lifetime, cached: refreshedAt !== undefined, expiresAt, replied };
}

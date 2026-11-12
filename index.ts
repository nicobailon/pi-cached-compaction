import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateCost, contentText, type Api, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	getAgentDir,
	getLastAssistantUsage,
	getLatestCompactionEntry,
	getSettingsListTheme,
	keyHint,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { cacheState, hasExplicitPromptCache, isKimiOnMoonshot, type CacheState } from "./cache-state.ts";
import {
	checkpointSummary,
	isPlainObject,
	keptStart,
	messageArrayKey,
	piCompactionInput,
	summaryInstruction,
	summaryPayload,
	trailingMessages,
	withKimiLongCache,
	withSharedPrefixCache,
	type CachedPrefix,
	type Payload,
	type PrefixMismatch,
} from "./cached-request.ts";
import {
	autoCompactionEnabled,
	COMPACT_AT_PERCENTS,
	COMPACT_AT_TOKEN_CHOICES,
	fullThreshold,
	loadConfig,
	MIN_CONTEXT_CHOICES,
	MIN_SUMMARY_TOKENS,
	saveConfig,
	summaryBudget,
	type CachedCompactionConfig,
} from "./config.ts";
import {
	appendTrace,
	comparison,
	describeTrace,
	formatDuration,
	formatRemaining,
	formatTokens,
	readTraces,
	TRACE_PATH_LABEL,
	traceDetails,
	type CompactTrace,
	type TraceEvent,
	type TraceRecord,
	type TraceUsage,
	type Trigger,
} from "./trace.ts";

interface CapturedRequest {
	transcript: AgentMessage[];
	payload?: Payload;
	model: Model<Api>;
	at: number;
}

interface CachedPath {
	request: CapturedRequest;
	prefix?: CachedPrefix;
	trailing: AgentMessage[];
	cache: CacheState;
}

const STATUS_KEY = "cached-compaction";
const CARD_TYPE = "cached-compaction";
const PREFIX_MISMATCH = "pi-cached-compaction: request prefix differs from the cached request";
const BRIDGE_API = "claude-bridge";
const FORK_REQUEST_HEADER = "x-claude-bridge-fork";
const EXPIRY_LEAD_MS = 20_000;
const WARNING_MS = 30_000;
const RETENTION_MARKER = "PI_CACHED_COMPACTION_RETENTION";
const INTERACTIVE_OWNER = Symbol.for("pi-cached-compaction.interactive-long-retention");

// Only OpenAI keeps tool_choice out of the cached prefix; elsewhere changing it costs cache.
function isOpenAiResponses(model: Model<Api>): boolean {
	return model.provider === "openai" && model.api === "openai-responses";
}

function sharedPrefixKey(model: Model<Api>, cwd: string): string | undefined {
	if (!hasExplicitPromptCache(model) || process.env.PI_CACHE_RETENTION !== "long") return undefined;
	return `pi-${createHash("sha256").update(cwd).digest("hex").slice(0, 40)}`;
}

function traceUsage(usage: Usage): TraceUsage {
	return { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, cost: usage.cost.total };
}

function applyRetention(preferLong: boolean, interactive: boolean): void {
	const current = process.env.PI_CACHE_RETENTION;
	if (current !== undefined && process.env[RETENTION_MARKER] !== current) return;
	const host = globalThis as Record<symbol, unknown>;
	if (preferLong && interactive) {
		process.env.PI_CACHE_RETENTION = process.env[RETENTION_MARKER] = "long";
		host[INTERACTIVE_OWNER] = true;
	} else if (interactive || !host[INTERACTIVE_OWNER]) {
		delete process.env.PI_CACHE_RETENTION;
		delete process.env[RETENTION_MARKER];
		host[INTERACTIVE_OWNER] = false;
	}
}

export default function cachedCompaction(pi: ExtensionAPI) {
	let config = loadConfig();

	let pendingTranscript: AgentMessage[] | undefined;
	let captured: CapturedRequest | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	// Set while a compaction the extension started itself is running.
	let ownTrigger: "expiry" | "full" | undefined;
	// The last "full" skip reason logged, so a context that stays past the mark logs each reason once.
	let lastFullSkip: string | undefined;
	// Set when compacting "when full" left the context past the mark, so it is not retried after every turn.
	let fullStuck = false;
	let compactionTrigger: Trigger | undefined;
	let decision: Extract<TraceRecord, { event: "compact" }> | undefined;
	let traceError: string | undefined;

	const trace = <E extends TraceEvent>(ctx: ExtensionContext, event: E) => {
		const record = { ...event, at: new Date().toISOString(), session: ctx.sessionManager.getSessionId() };
		try {
			appendTrace(record);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI && message !== traceError) ctx.ui.notify(`pi-cached-compaction could not write ${TRACE_PATH_LABEL}: ${message}`, "warning");
			traceError = message;
		}
		return record;
	};

	pi.registerEntryRenderer<{ records: TraceRecord[] }>(CARD_TYPE, (entry, { expanded }, theme) => {
		const records = entry.data?.records;
		if (!records?.length) return undefined;
		const lines = [`${theme.fg("accent", "cached compaction")}${expanded ? "" : `  ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "for details")}${theme.fg("muted", ")")}`}`];
		for (const record of records) {
			const line = describeTrace(record);
			const missed = record.event === "failed" || (record.event === "compact" && (record.outcome !== "cached" || record.response?.usage.cacheRead === 0));
			lines.push(missed ? theme.fg("warning", line) : line);
			const versus = record.event === "compact" ? comparison(record) : undefined;
			if (versus) {
				const text = `         ${versus.text}`;
				lines.push(versus.ratio <= 0.95 ? theme.fg("success", text) : versus.ratio >= 1.05 ? theme.fg("warning", text) : text);
			}
			if (expanded && record.event === "compact") lines.push(...traceDetails(record).map((detail) => theme.fg("dim", `         ${detail}`)));
		}
		if (expanded) lines.push(theme.fg("dim", `log: ${TRACE_PATH_LABEL}`));
		return new Text(lines.join("\n"), 1, 0);
	});
	const showCard = (records: TraceRecord[]) => pi.appendEntry<{ records: TraceRecord[] }>(CARD_TYPE, { records });

	const stopTimer = (ctx: ExtensionContext) => {
		clearInterval(ticker);
		ticker = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};
	const forget = (ctx: ExtensionContext) => {
		pendingTranscript = undefined;
		captured = undefined;
		stopTimer(ctx);
	};

	// A compaction can outlive its session (Pi exiting, /new, /reload). Pi then calls back with a ctx that throws on
	// use, and an error thrown from a callback takes the whole process down with exit code 1.
	const ifSessionAlive = (action: () => void) => {
		try {
			action();
		} catch {
			// The session this compaction belonged to is gone; there is nothing left to update.
		}
	};

	const compactBeforeExpiry = (ctx: ExtensionContext, remainingMs: number) => {
		if (!config.compactBeforeExpiry) return;
		const secondsLeft = Math.ceil(remainingMs / 1000);
		const contextTokens = ctx.getContextUsage()?.tokens ?? undefined;
		const skip = (reason: string) => trace(ctx, { event: "expiry", action: "skip", reason, secondsLeft, contextTokens });
		let compactionOn: boolean;
		try {
			compactionOn = autoCompactionEnabled(ctx.isProjectTrusted() ? ctx.cwd : undefined);
		} catch (error) {
			return skip(`Pi's settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!compactionOn) return skip("automatic compaction is off in Pi's settings");
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return skip("Pi is busy or has queued messages");
		if (contextTokens === undefined) return skip("the context size is unknown");
		if (contextTokens < config.minContextTokens) {
			return skip(`the context holds ${formatTokens(contextTokens)} tokens, under minContextTokens (${formatTokens(config.minContextTokens)})`);
		}
		const check = checkCachedPath(ctx.sessionManager.getBranch(), ctx.model);
		if ("reason" in check) return skip(check.reason);
		trace(ctx, { event: "expiry", action: "compact", secondsLeft, contextTokens });
		ownTrigger = "expiry";
		stopTimer(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(`Prompt cache expires in ${secondsLeft}s with ${formatTokens(contextTokens)} tokens of context. Compacting now, while the cache is warm.`, "info");
		}
		ctx.compact({
			onComplete: () => {
				ownTrigger = undefined;
			},
			onError: () => {
				ownTrigger = undefined;
				ifSessionAlive(() => {
					if (ctx.isIdle()) startTimer(ctx, false);
				});
			},
		});
	};

	// After a turn, compacts once the context passes compactAtPercent of the window or the compactAtTokens cap,
	// whichever comes first, so a summary still fits beside it
	// and the cache the turn just wrote is warm. Returns whether a compaction started.
	const compactWhenFull = (ctx: ExtensionContext): boolean => {
		// In print and JSON mode nothing follows a settled run: the process is exiting, so a compaction started here is
		// cut off before its request is sent. There, Pi's own between-turn check (compaction.reserveTokens) starts
		// compaction during the run, and session_before_compact still writes that summary from the cache.
		if (!ctx.hasUI) return false;
		const threshold = ctx.model ? fullThreshold(ctx.model, config.compactAtPercent, config.compactAtTokens) : undefined;
		const contextTokens = ctx.getContextUsage()?.tokens ?? undefined;
		if (threshold === undefined || contextTokens === undefined || contextTokens < threshold) {
			lastFullSkip = undefined;
			fullStuck = false;
			return false;
		}
		const cap = config.compactAtTokens > 0 && threshold === config.compactAtTokens ? config.compactAtTokens : undefined;
		const base = { contextTokens, threshold, percent: config.compactAtPercent, ...(cap === undefined ? {} : { tokens: cap }) };
		const skip = (reason: string) => {
			if (reason !== lastFullSkip) trace(ctx, { event: "full", action: "skip", reason, ...base });
			lastFullSkip = reason;
			return false;
		};
		if (fullStuck) return skip("the last compaction left the context past the mark (raise compactAtPercent or compactAtTokens, or keep fewer recent tokens)");
		let compactionOn: boolean;
		try {
			compactionOn = autoCompactionEnabled(ctx.isProjectTrusted() ? ctx.cwd : undefined);
		} catch (error) {
			return skip(`Pi's settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!compactionOn) return skip("automatic compaction is off in Pi's settings");
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return skip("Pi is busy or has queued messages");
		lastFullSkip = undefined;
		trace(ctx, { event: "full", action: "compact", ...base });
		ownTrigger = "full";
		stopTimer(ctx);
		if (ctx.hasUI) {
			const mark = cap === undefined ? `${config.compactAtPercent}% of the model's window` : `your ${formatTokens(cap)}-token cap`;
			ctx.ui.notify(`The context holds ${formatTokens(contextTokens)} tokens, past ${mark}. Compacting now, while the cache is warm.`, "info");
		}
		ctx.compact({
			onComplete: () => {
				ownTrigger = undefined;
				ifSessionAlive(() => {
					const after = ctx.getContextUsage()?.tokens;
					fullStuck = after !== undefined && after !== null && after >= threshold;
				});
			},
			onError: () => {
				ownTrigger = undefined;
				fullStuck = true;
				ifSessionAlive(() => {
					if (ctx.isIdle()) startTimer(ctx);
				});
			},
		});
		return true;
	};

	const startTimer = (ctx: ExtensionContext, compactAtExpiry = true) => {
		stopTimer(ctx);
		const readExpiry = () => (ctx.model ? cacheState(ctx.model, ctx.sessionManager.getBranch()).expiresAt : undefined);
		const firstExpiry = readExpiry();
		if (firstExpiry === undefined) return;
		let expiresAt = firstExpiry;
		let shown: string | undefined;
		let ticks = 0;
		let attempted = !compactAtExpiry;
		const tick = () => {
			if (++ticks % 15 === 0 || expiresAt - Date.now() <= EXPIRY_LEAD_MS) expiresAt = readExpiry() ?? expiresAt;
			const remaining = expiresAt - Date.now();
			const text = formatRemaining(remaining);
			if (ctx.hasUI && text !== shown) {
				shown = text;
				ctx.ui.setStatus(STATUS_KEY, remaining <= WARNING_MS ? ctx.ui.theme.fg(remaining > 0 ? "warning" : "dim", text) : text);
			}
			if (remaining <= 0) {
				clearInterval(ticker);
				ticker = undefined;
			} else if (remaining <= EXPIRY_LEAD_MS && !attempted) {
				attempted = true;
				compactBeforeExpiry(ctx, remaining);
			}
		};
		ticker = setInterval(tick, 1000);
		ticker.unref();
		tick();
	};

	pi.on("context_with_system", (event) => {
		pendingTranscript = [...event.messages];
	});
	pi.on("before_provider_request", (event, ctx) => {
		const transcript = pendingTranscript;
		pendingTranscript = undefined;
		if (!ctx.model || !isPlainObject(event.payload)) return;
		const sharedKey = sharedPrefixKey(ctx.model, ctx.cwd);
		let payload = sharedKey ? withSharedPrefixCache(event.payload, sharedKey) : event.payload;
		if (isKimiOnMoonshot(ctx.model)) payload = withKimiLongCache(payload);
		if (transcript) captured = { transcript, payload, model: ctx.model, at: Date.now() };
		return payload === event.payload ? undefined : payload;
	});
	pi.on("message_start", (event, ctx) => {
		const transcript = pendingTranscript;
		pendingTranscript = undefined;
		if (transcript && event.message.role === "assistant" && ctx.model?.api === BRIDGE_API) captured = { transcript, model: ctx.model, at: Date.now() };
	});
	pi.on("session_start", (_event, ctx) => {
		applyRetention(config.cacheRetention === "long", ctx.hasUI);
		startTimer(ctx);
	});
	pi.on("agent_start", (_event, ctx) => stopTimer(ctx));
	pi.on("agent_settled", (_event, ctx) => {
		if (!compactWhenFull(ctx)) startTimer(ctx);
	});
	pi.on("session_compact", (event, ctx) => {
		const entry = event.compactionEntry;
		const result = trace(ctx, {
			event: "result",
			trigger: compactionTrigger ?? event.reason,
			by: event.fromExtension ? "extension" : "pi",
			entryId: entry.id,
			tokensBefore: entry.tokensBefore,
			usage: entry.usage ? traceUsage(entry.usage) : undefined,
			summaryChars: entry.summary.length,
		});
		// Pi redraws the chat after this handler returns; appending now would put the card above the summary.
		const records = decision ? [decision, result] : [result];
		setTimeout(() => showCard(records), 0);
		decision = undefined;
		compactionTrigger = undefined;
		forget(ctx);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		const failed = trace(ctx, { event: "failed", trigger: compactionTrigger ?? event.reason, aborted: event.aborted, error: event.errorMessage });
		if (decision) showCard(decision.outcome === "cancelled" && event.aborted ? [decision] : [decision, failed]);
		decision = undefined;
		compactionTrigger = undefined;
	});
	pi.on("model_select", (_event, ctx) => forget(ctx));
	pi.on("session_tree", (_event, ctx) => {
		forget(ctx);
		startTimer(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => stopTimer(ctx));

	const checkCachedPath = (entries: SessionEntry[], model: Model<Api> | undefined): CachedPath | { reason: string } => {
		const request = captured;
		if (!request) return { reason: "no request since the session started or compacted, or since the model or branch changed" };
		if (model?.provider !== request.model.provider || model.id !== request.model.id) return { reason: "the model changed since the last request" };
		let prefix: CachedPrefix | undefined;
		if (request.payload) {
			const key = messageArrayKey(request.payload);
			if (!key) return { reason: `${request.model.api} requests are not supported` };
			prefix = { payload: request.payload, key };
		}
		const trailing = trailingMessages(entries, request.transcript);
		if ("reason" in trailing) return { reason: `the conversation changed since the last request: ${trailing.reason}` };
		const cache = cacheState(request.model, entries);
		if (!cache.cached) return { reason: "the last request did not use the prompt cache" };
		if (cache.expiresAt !== undefined && Date.now() >= cache.expiresAt) return { reason: "the prompt cache has expired" };
		return { request, prefix, trailing: trailing.messages, cache };
	};

	pi.on("session_before_compact", async (event, ctx) => {
		// Before expiry, Pi's own compaction would pay full price for nothing urgent, so a failed cached path cancels;
		// when full, Pi's compaction is still wanted.
		const fromExpiry = ownTrigger === "expiry";
		const trigger: Trigger = ownTrigger ?? event.reason;
		compactionTrigger = trigger;
		const { preparation } = event;
		const record: CompactTrace = {
			event: "compact",
			trigger,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
			outcome: "cached",
			tokensBefore: preparation.tokensBefore,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
		};
		const fallBack = (reason: string, mismatch?: PrefixMismatch) => {
			const diff = mismatch?.captured === undefined ? undefined : { captured: mismatch.captured, rebuilt: mismatch.rebuilt };
			decision = trace(ctx, { ...record, outcome: fromExpiry ? "cancelled" : "fallback", reason, mismatch: diff });
			return fromExpiry ? { cancel: true } : undefined;
		};
		if (event.reason === "overflow") return fallBack("the last request overflowed the context window");
		const check = checkCachedPath(event.branchEntries, ctx.model);
		if ("reason" in check) return fallBack(check.reason);
		const { request, prefix, trailing, cache } = check;
		const lastUsage = getLastAssistantUsage(event.branchEntries);
		record.lastRequest = {
			secondsAgo: Math.round((Date.now() - request.at) / 1000),
			messages: request.transcript.length,
			promptTokens: lastUsage && lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite,
			newMessages: trailing.length,
		};
		record.cache = {
			lifetimeSeconds: cache.lifetime && cache.lifetime.ms / 1000,
			source: cache.lifetime?.source,
			expiresInSeconds: cache.expiresAt === undefined ? undefined : Math.round((cache.expiresAt - Date.now()) / 1000),
		};

		const budget = summaryBudget(request.model, preparation.tokensBefore);
		if (budget !== undefined && budget < MIN_SUMMARY_TOKENS) {
			return fallBack(`only ${formatTokens(budget)} tokens of the context window are left for the summary (it needs ${formatTokens(MIN_SUMMARY_TOKENS)})`);
		}
		const maxTokens = budget ?? Math.floor(0.8 * preparation.settings.reserveTokens);

		const kept = keptStart(event.branchEntries, preparation.firstKeptEntryId, [...request.transcript, ...trailing]);
		if (!kept) return fallBack("no kept message in the request has text to mark where the summary ends");
		const instruction: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: summaryInstruction(kept, event.customInstructions) }],
			timestamp: Date.now(),
		};

		let mismatch: PrefixMismatch | undefined;
		const thinkingLevel = pi.getThinkingLevel();
		const controller = new AbortController();
		const disableTools = prefix !== undefined && isOpenAiResponses(request.model);
		const cacheNeutral = new Set(disableTools ? ["tool_choice"] : []);
		const sharedKey = prefix ? sharedPrefixKey(request.model, ctx.cwd) : undefined;
		const requestInfo = { thinking: thinkingLevel, bridgeFork: prefix === undefined, toolChoiceNone: disableTools, sharedPrefix: false };
		record.request = requestInfo;
		const started = Date.now();
		const sent = [...request.transcript, ...trailing, instruction];
		let response: AssistantMessage;
		try {
			response = await ctx.modelRegistry
				.streamSimple(request.model, { messages: convertToLlm(sent) }, {
				reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
				maxTokens,
				sessionId: ctx.sessionManager.getSessionId(),
				signal: AbortSignal.any([event.signal, controller.signal]),
				...(disableTools ? { toolChoice: "none" as const } : {}),
				...(prefix
					? {
						onPayload: (params: unknown) => {
							const built = summaryPayload(params, prefix, sharedKey, cacheNeutral);
							requestInfo.sharedPrefix = built.sharedPrefix;
							if ("reason" in built) {
								mismatch = built;
								throw new Error(PREFIX_MISMATCH);
							}
							return built.payload;
						},
					}
					: { headers: { [FORK_REQUEST_HEADER]: "1" }, cacheRetention: "none" as const }),
				})
				.result();
		} catch (error) {
			return fallBack(`the summary request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// A bridge query that called a tool waits for the result until aborted.
		if (response.stopReason === "toolUse") controller.abort();
		const summary = contentText(response.content).trim();
		record.response = {
			stopReason: response.stopReason,
			seconds: (Date.now() - started) / 1000,
			usage: traceUsage(response.usage),
			summaryChars: summary.length,
			error: mismatch ? undefined : response.errorMessage,
		};

		if (response.stopReason === "aborted") {
			decision = trace(ctx, { ...record, outcome: "cancelled", reason: "the compaction was aborted" });
			return { cancel: true };
		}
		if (mismatch) return fallBack(mismatch.reason, mismatch);
		if (response.stopReason === "error") return fallBack(response.errorMessage ?? "the summary request failed");
		if (response.stopReason === "length") return fallBack("the summary hit the output limit");
		if (response.stopReason === "toolUse") return fallBack("the model called a tool instead of writing the summary");
		if (!summary) return fallBack("the model returned no summary text");

		const checkpoint = checkpointSummary(summary, preparation.fileOps, getLatestCompactionEntry(event.branchEntries)?.details);
		const promptTokens = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
		if (promptTokens > 0) {
			const piInput = piCompactionInput(preparation, sent, promptTokens);
			const piUsage: Usage = { ...response.usage, input: piInput, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: { ...response.usage.cost } };
			record.piEstimate = { input: piInput, cost: calculateCost(request.model, piUsage).total };
		}
		decision = trace(ctx, record);

		return {
			compaction: {
				summary: checkpoint.summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage: response.usage,
				details: { readFiles: checkpoint.readFiles, modifiedFiles: checkpoint.modifiedFiles },
			},
		};
	});

	const percentLabel = (percent: number) => (percent === 0 ? "off" : `${percent}%`);
	const capLabel = (tokens: number) => (tokens === 0 ? "off" : `${formatTokens(tokens)} tokens`);
	const fullNote = (model: Model<Api> | undefined): string => {
		const { compactAtPercent: percent, compactAtTokens: cap } = config;
		if (percent === 0 && cap === 0) return "off: Pi compacts only when the window is nearly full, often with too little room left for a cached summary";
		const at = model ? fullThreshold(model, percent, cap) : undefined;
		if (!model || at === undefined) return `at ${percent}% of the window; the current model declares no window, so not here`;
		const byCap = cap > 0 && at === cap;
		const budget = summaryBudget(model, at);
		const room = budget === undefined ? "" : `, leaving ${formatTokens(budget)} for the summary`;
		const tight = budget !== undefined && budget < MIN_SUMMARY_TOKENS ? `, too little for a cached summary: pick a lower ${byCap ? "cap" : "percentage"}` : "";
		const mark = byCap ? `at the ${formatTokens(cap)}-token cap` : `at ${percent}%: ${formatTokens(at)} of ${formatTokens(model.contextWindow)}`;
		return `${mark} on ${model.provider}/${model.id}${room}${tight}`;
	};
	const expiryNote = () => (config.compactBeforeExpiry ? `on, from ${formatTokens(config.minContextTokens)} tokens of context` : "off");

	const openSettings = async (ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				[
					"pi-cached-compaction settings (cachedCompaction in ~/.pi/agent/settings.json; /cached-compaction-settings in the TUI changes them)",
					`compactAtPercent: ${config.compactAtPercent} · compactAtTokens: ${config.compactAtTokens} (${fullNote(ctx.model)})`,
					`compactBeforeExpiry: ${config.compactBeforeExpiry} · minContextTokens: ${config.minContextTokens}`,
					`cacheRetention: ${config.cacheRetention}`,
				].join("\n"),
				"info",
			);
			return;
		}
		const percents = [...new Set([...COMPACT_AT_PERCENTS, config.compactAtPercent])].sort((a, b) => a - b);
		const caps = [...new Set([...COMPACT_AT_TOKEN_CHOICES, config.compactAtTokens])].sort((a, b) => a - b);
		const minimums = [...new Set([...MIN_CONTEXT_CHOICES, config.minContextTokens])].sort((a, b) => a - b);
		const fullItem: SettingItem = {
			id: "compactAtPercent",
			label: "Compact when the context is",
			currentValue: percentLabel(config.compactAtPercent),
			values: percents.map(percentLabel),
			description: "",
		};
		const describeFull = () => {
			fullItem.description = `After a turn, once the context fills this share of the model's window, compact from the warm cache so the summary still fits beside it. Now ${fullNote(ctx.model)}.`;
		};
		describeFull();
		const items: SettingItem[] = [
			fullItem,
			{
				id: "compactAtTokens",
				label: "Or once it holds",
				currentValue: capLabel(config.compactAtTokens),
				values: caps.map(capLabel),
				description:
					"Also compact after a turn once the context holds this many tokens, on any model, whichever comes first. Every request reads the whole context from the cache, so a smaller context makes each request cheaper; older detail is summarized sooner.",
			},
			{
				id: "compactBeforeExpiry",
				label: "Compact before the cache expires",
				currentValue: config.compactBeforeExpiry ? "on" : "off",
				values: ["on", "off"],
				description: "20 s before the prompt cache expires, when Pi is idle, compact from the still-warm cache instead of paying to write the whole session again with your next message.",
			},
			{
				id: "minContextTokens",
				label: "Before expiry, only from",
				currentValue: formatTokens(config.minContextTokens),
				values: minimums.map(formatTokens),
				description: "The smallest context worth compacting before expiry; smaller sessions are cheap to write again, so they are left to cool.",
			},
			{
				id: "cacheRetention",
				label: "Cache retention",
				currentValue: config.cacheRetention,
				values: ["short", "long"],
				description: "long asks for the longer cache in interactive sessions (2× the write price on Anthropic and Kimi); short keeps Pi's default. Applies from the next request.",
			},
		];
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const list = new SettingsList(
				items,
				items.length + 2,
				getSettingsListTheme(),
				(id, value) => {
					let patch: Partial<CachedCompactionConfig>;
					if (id === "compactAtPercent") patch = { compactAtPercent: percents.find((p) => percentLabel(p) === value) ?? config.compactAtPercent };
					else if (id === "compactAtTokens") patch = { compactAtTokens: caps.find((n) => capLabel(n) === value) ?? config.compactAtTokens };
					else if (id === "compactBeforeExpiry") patch = { compactBeforeExpiry: value === "on" };
					else if (id === "minContextTokens") patch = { minContextTokens: minimums.find((n) => formatTokens(n) === value) ?? config.minContextTokens };
					else patch = { cacheRetention: value === "long" ? "long" : "short" };
					try {
						config = saveConfig(patch);
					} catch (error) {
						ctx.ui.notify(`pi-cached-compaction could not save the setting: ${error instanceof Error ? error.message : String(error)}`, "error");
						return;
					}
					if (id === "cacheRetention") applyRetention(config.cacheRetention === "long", ctx.hasUI);
					if (id === "compactAtPercent" || id === "compactAtTokens") {
						fullStuck = false;
						lastFullSkip = undefined;
						describeFull();
					}
					list.invalidate();
				},
				() => done(),
			);
			const container = new Container();
			container.addChild(new Text(`${theme.fg("accent", theme.bold("pi-cached-compaction"))} ${theme.fg("dim", "saved to cachedCompaction in ~/.pi/agent/settings.json")}`, 0, 0));
			container.addChild(new Text("", 0, 0));
			container.addChild(list);
			return {
				capturesViewportInput: list.capturesViewportInput,
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	pi.registerCommand("cached-compaction-settings", {
		description: "Change pi-cached-compaction's settings: compact when full, compact before expiry, cache retention",
		handler: async (_args, ctx) => openSettings(ctx),
	});

	pi.registerCommand("cached-compaction", {
		description:
			"Show the prompt cache state and this session's compaction log; `settings` changes this extension's settings; `cache-flag` turns on OpenAI's cache options for GPT on opencode-go",
		getArgumentCompletions: (prefix) => {
			const matches = ["settings", "cache-flag"].filter((value) => value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			if (args.trim() === "settings") return openSettings(ctx);
			const flagless = ctx.modelRegistry.getAll().filter((m) => m.provider === "opencode-go" && m.api === "openai-responses" &&
				!("supportsExplicitPromptCacheMode" in (m.compat ?? {})) && hasExplicitPromptCache(ctx.modelRegistry.find("openai", m.id) ?? m)).map((m) => m.id);
			if (args.trim() === "cache-flag") {
				if (flagless.length === 0) return ctx.ui.notify("Every opencode-go model that supports OpenAI's cache options already has the flag.", "info");
				const path = join(getAgentDir(), "models.json");
				let file;
				try {
					file = JSON.parse(existsSync(path) ? readFileSync(path, "utf8") : "{}");
				} catch {
					return ctx.ui.notify(`${path} has comments or isn't valid JSON, so add the flag by hand as the README shows.`, "error");
				}
				const overrides = ((file.providers ??= {})["opencode-go"] ??= {}).modelOverrides ??= {};
				for (const id of flagless) ((overrides[id] ??= {}).compat ??= {}).supportsExplicitPromptCacheMode = true;
				writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
				await ctx.modelRegistry.refresh({ providers: ["opencode-go"], allowNetwork: false });
				// setModel resets the thinking level.
				const current = ctx.model?.provider === "opencode-go" && flagless.includes(ctx.model.id) ? ctx.modelRegistry.find("opencode-go", ctx.model.id) : undefined;
				const level = pi.getThinkingLevel();
				if (current && (await pi.setModel(current))) pi.setThinkingLevel(level);
				return ctx.ui.notify(`Turned on OpenAI's cache options in ${path} for opencode-go/${flagless.join(", opencode-go/")}.`, "info");
			}
			const entries = ctx.sessionManager.getBranch();
			const model = ctx.model;
			const state = model && cacheState(model, entries);
			let cache = "lifetime unknown, so no countdown";
			if (model?.provider === "opencode-go" && flagless.includes(model.id)) cache += "; run /cached-compaction cache-flag to get one";
			if (state?.lifetime) {
				let left = state.replied ? "the last request did not use the prompt cache" : "no request since the session started or compacted";
				if (state.expiresAt !== undefined) left = state.expiresAt > Date.now() ? `${formatRemaining(state.expiresAt - Date.now())} left` : "expired";
				cache = `${left} (lifetime ${formatDuration(state.lifetime.ms)}, ${state.lifetime.source})`;
			}
			const check = checkCachedPath(entries, model);
			const next = "reason" in check
				? `Pi's compaction, because ${check.reason}`
				: `cached path; last request ${formatDuration(Date.now() - check.request.at)} ago with ${check.request.transcript.length} messages, ${check.trailing.length} since. The request prefix is checked when it runs.`;
			let log: string[];
			try {
				const records = readTraces(ctx.sessionManager.getSessionId(), 12);
				const lines = records.flatMap((record) => {
					const versus = record.event === "compact" ? comparison(record) : undefined;
					return versus ? [describeTrace(record), `         ${versus.text}`] : [describeTrace(record)];
				});
				log = records.length > 0 ? ["This session:", ...lines] : ["Nothing logged for this session yet."];
			} catch (error) {
				log = [`Could not read the log: ${error instanceof Error ? error.message : String(error)}`];
			}
			ctx.ui.notify(
				[
					`pi-cached-compaction · ${model ? `${model.provider}/${model.id}` : "no model"}`,
					`cache: ${cache}`,
					`next compaction: ${next}`,
					`when full: ${fullNote(model)}`,
					`before expiry: ${expiryNote()} · retention ${model?.api === BRIDGE_API ? "set by Claude Code" : (process.env.PI_CACHE_RETENTION ?? "short")}`,
					"settings: /cached-compaction-settings",
					`log: ${TRACE_PATH_LABEL}`,
					"",
					...log,
				].join("\n"),
				"info",
			);
		},
	});
}

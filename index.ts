import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateCost, contentText, type Api, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { convertToLlm, getAgentDir, getLastAssistantUsage, getLatestCompactionEntry, keyHint, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
import { autoCompactionEnabled, loadConfig } from "./config.ts";
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
	const config = loadConfig();

	let pendingTranscript: AgentMessage[] | undefined;
	let captured: CapturedRequest | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let expiryCompaction = false;
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
		expiryCompaction = true;
		stopTimer(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(`Prompt cache expires in ${secondsLeft}s with ${formatTokens(contextTokens)} tokens of context. Compacting now, while the cache is warm.`, "info");
		}
		ctx.compact({
			onComplete: () => {
				expiryCompaction = false;
			},
			onError: () => {
				expiryCompaction = false;
				if (ctx.isIdle()) startTimer(ctx, false);
			},
		});
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
	pi.on("agent_settled", (_event, ctx) => startTimer(ctx));
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
		const fromExpiry = expiryCompaction;
		const trigger: Trigger = fromExpiry ? "expiry" : event.reason;
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
				maxTokens: Math.min(Math.floor(0.8 * preparation.settings.reserveTokens), request.model.maxTokens > 0 ? request.model.maxTokens : Infinity),
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

	pi.registerCommand("cached-compaction", {
		description: "Show the prompt cache state and this session's compaction log; `cache-flag` turns on OpenAI's cache options for GPT on opencode-go",
		handler: async (args, ctx) => {
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
					`before expiry: ${config.compactBeforeExpiry ? `on, from ${formatTokens(config.minContextTokens)} tokens of context` : "off"} · retention ${model?.api === BRIDGE_API ? "set by Claude Code" : (process.env.PI_CACHE_RETENTION ?? "short")}`,
					`log: ${TRACE_PATH_LABEL}`,
					"",
					...log,
				].join("\n"),
				"info",
			);
		},
	});
}

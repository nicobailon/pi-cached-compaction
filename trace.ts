import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const TRACE_PATH = join(getAgentDir(), "cached-compaction.jsonl");
export const TRACE_PATH_LABEL = TRACE_PATH.startsWith(homedir()) ? `~${TRACE_PATH.slice(homedir().length)}` : TRACE_PATH;
const MAX_TRACE_BYTES = 5_000_000;

export type Trigger = "manual" | "threshold" | "overflow" | "expiry";

export interface TraceUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
}

export interface CompactTrace {
	event: "compact";
	trigger: Trigger;
	model: string;
	outcome: "cached" | "fallback" | "cancelled";
	reason?: string;
	mismatch?: { captured?: string; rebuilt?: string };
	tokensBefore: number;
	cwd: string;
	sessionFile?: string;
	lastRequest?: { secondsAgo: number; messages: number; promptTokens?: number; newMessages: number };
	cache?: { lifetimeSeconds?: number; source?: string; expiresInSeconds?: number };
	request?: { thinking: string; bridgeFork: boolean; toolChoiceNone: boolean; sharedPrefix: boolean };
	response?: { stopReason: string; seconds: number; usage: TraceUsage; summaryChars: number; error?: string };
	piEstimate?: { input: number; cost: number };
}

export interface ResultTrace {
	event: "result";
	trigger: Trigger;
	by: "extension" | "pi";
	entryId: string;
	tokensBefore: number;
	usage?: TraceUsage;
	summaryChars: number;
}

export interface FailedTrace {
	event: "failed";
	trigger: Trigger;
	aborted: boolean;
	error?: string;
}

export interface ExpiryTrace {
	event: "expiry";
	action: "compact" | "skip";
	reason?: string;
	secondsLeft: number;
	contextTokens?: number;
}

export type TraceEvent = CompactTrace | ResultTrace | FailedTrace | ExpiryTrace;
export type TraceRecord = TraceEvent & { at: string; session: string };
const TRACE_EVENTS = new Set<string>(["compact", "result", "failed", "expiry"] satisfies TraceEvent["event"][]);

export function appendTrace(record: TraceRecord): void {
	try {
		if (statSync(TRACE_PATH).size > MAX_TRACE_BYTES) renameSync(TRACE_PATH, `${TRACE_PATH}.1`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	appendFileSync(TRACE_PATH, `${JSON.stringify(record)}\n`);
}

export function readTraces(session: string, limit: number): TraceRecord[] {
	let text: string;
	try {
		text = readFileSync(TRACE_PATH, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: TraceRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		// Skips lines cut short by a crash and events from other versions.
		try {
			const record = JSON.parse(line) as TraceRecord;
			if (record.session === session && TRACE_EVENTS.has(record.event)) records.push(record);
		} catch {}
	}
	return records.slice(-limit);
}

const TRIGGER_LABELS: Record<Trigger, string> = {
	manual: "/compact",
	threshold: "auto-compaction",
	overflow: "overflow recovery",
	expiry: "compact before expiry",
};

function cacheShare(usage: TraceUsage): string {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const pct = prompt > 0 ? Math.floor((100 * usage.cacheRead) / prompt) : 0;
	return `${pct}% of ${formatTokens(prompt)} from cache, ${formatTokens(usage.output)} out`;
}

function formatCost(cost: number): string {
	return `$${Number(cost.toPrecision(2))}`;
}

export function comparison(record: CompactTrace): { text: string; ratio: number } | undefined {
	const { piEstimate, response } = record;
	if (record.outcome !== "cached" || !piEstimate || !response) return undefined;
	const { usage } = response;
	const priced = piEstimate.cost > 0;
	const ratio = priced ? usage.cost / piEstimate.cost : (usage.input + usage.cacheWrite) / piEstimate.input;
	const delta =
		ratio <= 0.95 ? `${Math.round(100 * (1 - ratio))}% less`
		: ratio < 1.05 ? "about the same"
		: ratio < 2 ? `${Math.round(100 * (ratio - 1))}% more`
		: `${ratio.toFixed(1)}× as much`;
	const text = priced
		? `vs Pi's compaction: ${delta}, ${formatCost(usage.cost)} instead of ~${formatCost(piEstimate.cost)} (it sends ~${formatTokens(piEstimate.input)} tokens, none from cache)`
		: `vs Pi's compaction: ${delta}, ${formatTokens(usage.input + usage.cacheWrite)} tokens not from cache instead of ~${formatTokens(piEstimate.input)}`;
	return { text, ratio };
}

export function formatRemaining(ms: number): string {
	if (ms <= 0) return "cache cold";
	const seconds = Math.ceil(ms / 1000);
	if (seconds >= 120) return `⏱ ${Math.floor(seconds / 60)}m`;
	return `⏱ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatTokens(count: number): string {
	return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

export function formatDuration(ms: number): string {
	return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

export function describeTrace(record: TraceRecord): string {
	const time = new Date(record.at).toLocaleTimeString([], { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
	switch (record.event) {
		case "compact": {
			const what = TRIGGER_LABELS[record.trigger];
			if (record.outcome === "cached" && record.response) {
				const { usage, seconds, summaryChars } = record.response;
				return `${time} ${what}: cached, ${cacheShare(usage)}, ${seconds.toFixed(1)}s, summary ${summaryChars} chars`;
			}
			const then = record.outcome === "fallback" ? "Pi's compaction" : "cancelled";
			const usage = record.response?.usage;
			const spent = usage && usage.input + usage.cacheRead + usage.cacheWrite > 0 ? ` (the summary request used ${cacheShare(usage)}, ${formatCost(usage.cost)})` : "";
			return `${time} ${what}: ${then}, ${record.reason}${spent}`;
		}
		case "result":
			return record.by === "pi"
				? `${time}   Pi's compaction saved${record.usage ? `: ${cacheShare(record.usage)}, ${formatCost(record.usage.cost)}` : ""}, summary ${record.summaryChars} chars`
				: `${time}   saved, ${formatTokens(record.tokensBefore)} tokens summarized`;
		case "failed":
			return `${time} ${TRIGGER_LABELS[record.trigger]}: ${record.aborted ? "aborted" : (record.error ?? "failed")}`;
		case "expiry":
			return record.action === "compact"
				? `${time} cache expires in ${record.secondsLeft}s: compacting ${formatTokens(record.contextTokens ?? 0)} tokens`
				: `${time} cache expires in ${record.secondsLeft}s: not compacting, ${record.reason}`;
	}
}

export function traceDetails(record: CompactTrace): string[] {
	const lines: string[] = [];
	const { cache, lastRequest, request, response, mismatch } = record;
	if (cache) {
		const lifetime = cache.lifetimeSeconds === undefined ? "lifetime unknown" : `lifetime ${formatDuration(cache.lifetimeSeconds * 1000)} (${cache.source})`;
		const left = cache.expiresInSeconds === undefined ? "" : `, ${formatDuration(cache.expiresInSeconds * 1000)} left`;
		lines.push(`cache: ${lifetime}${left}`);
	}
	if (lastRequest) {
		const sent = lastRequest.promptTokens ? `, ${formatTokens(lastRequest.promptTokens)} prompt tokens` : "";
		lines.push(`last request: ${formatDuration(lastRequest.secondsAgo * 1000)} ago, ${lastRequest.messages} messages${sent}, ${lastRequest.newMessages} new since`);
	}
	if (request) {
		const extras = [
			request.sharedPrefix ? "shared 12h prefix" : "",
			request.toolChoiceNone ? "tool_choice none" : "",
			request.bridgeFork ? "Claude Code fork" : "",
		].filter(Boolean);
		lines.push(`request: thinking ${request.thinking}${extras.map((extra) => `, ${extra}`).join("")}`);
	}
	if (response?.error) lines.push(`error: ${response.error}`);
	if (mismatch?.captured !== undefined) lines.push(`last request had: ${mismatch.captured}`, `summary request had: ${mismatch.rebuilt ?? "(nothing)"}`);
	return lines;
}

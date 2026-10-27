import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/** ID of the Rex session hosting the child pi; set once the run is launched. */
	rexSession?: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			(metadata.rexSession !== undefined && typeof metadata.rexSession !== "string") ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Session label shown in the Rex app for a run. */
export function rexSessionLabel(handle: string): string {
	return `pi-subagent-${handle}`;
}

/** Run the rex CLI and return its output, throwing its error message on failure. */
function rex(args: string[], input?: string): string {
	const result = spawnSync("rex", args, { encoding: "utf8", input });
	if (result.status !== 0) {
		throw new Error(
			result.error?.message || result.stderr.trim().replace(/^Error: /, "") || `rex ${args.join(" ")} failed`,
		);
	}
	return result.stdout;
}

function closeRexSession(sessionId: string): void {
	spawnSync("rex", ["kill", sessionId], { stdio: "ignore" });
}

/** Destroy the run's Rex session, ending its pi process; a session that is already gone is ignored. */
export function closeRunSession(metadata: RunMetadata): void {
	if (metadata.rexSession) closeRexSession(metadata.rexSession);
}

/**
 * Ask the Rex app showing `viewerSession` to switch to the run's session. The app must have Remote Control on.
 * When exactly one app shows `viewerSession` it is targeted; otherwise rex picks the only connected app or fails.
 */
export function showRunSession(metadata: RunMetadata, viewerSession: string): void {
	if (!metadata.rexSession) throw new Error(`${metadata.handle} has no Rex session`);
	const listed = JSON.parse(rex(["client", "ls", "-s", viewerSession, "--json"])) as {
		clients?: { client_id: string; info?: { kind?: string } }[];
	};
	const apps = (listed.clients ?? []).filter((client) => client.info?.kind === "app");
	const target = apps.length === 1 ? ["-C", apps[0].client_id] : [];
	rex([...target, "do", "session.select", `session_id=${metadata.rexSession}`]);
}

/** A Rex session outlives the program in it, so a run is alive only while its terminal block exists. */
export function isRunAlive(metadata: RunMetadata): boolean {
	if (!metadata.rexSession) return false;
	try {
		const value = JSON.parse(rex(["block", "ls", "-s", metadata.rexSession, "--json"])) as { blocks?: unknown[] };
		return (value.blocks?.length ?? 0) > 0;
	} catch {
		return false;
	}
}

/**
 * Start the child pi process for a run in a new Rex session and record that session in the run's metadata.
 * `initialArgs` are only passed on first spawn.
 */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): RunMetadata {
	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}

	// The terminal runs pi through the login shell so pi and its environment are found as in a normal terminal.
	const terminal = {
		flavor: "com.superlogical.terminal.shell",
		options: {
			cwd: metadata.cwd,
			command: [
				"env",
				`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
				launcher,
				"--session",
				metadata.sessionFile,
				"--provider",
				metadata.provider,
				"--model",
				metadata.model,
				"--thinking",
				metadata.thinking,
				...(metadata.launchArgs ?? []),
				...initialArgs,
			],
			size: { columns: 120, rows: 40 },
			// Close the terminal whenever pi exits, even right after starting, so the run reads as exited.
			exit: { on_completion: true, quick_exit_threshold_ms: 0 },
		},
	};

	// Record the session before pi starts so the child's own metadata updates cannot race with this one.
	const created = JSON.parse(
		rex(["api", "call", "session.create", "-"], JSON.stringify({ label: rexSessionLabel(metadata.handle) })),
	) as { session_id: string };
	try {
		const launched = updateMetadata(metadata.runDir, { rexSession: created.session_id });
		if (!launched) throw new Error(`Unknown subagent run: ${metadata.handle}`);
		rex(
			["api", "call", "-s", created.session_id, "session.new_window", "-"],
			JSON.stringify({ layout: { block: terminal } }),
		);
		return launched;
	} catch (error) {
		closeRexSession(created.session_id);
		throw error;
	}
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!isRunAlive(metadata)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}

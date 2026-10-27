import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunMetadata } from "../shared.ts";

/** A temporary project directory whose pi-test.sh replaces the pi executable for launched runs. */
export function makeProject(launcherBody: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-project-")));
	const launcher = join(dir, "pi-test.sh");
	writeFileSync(launcher, `#!/bin/sh\n${launcherBody}\n`);
	chmodSync(launcher, 0o755);
	return dir;
}

/** Launcher body that records how it was started, then stays alive for `seconds`. */
export function recordingLauncher(seconds: number): string {
	return [
		'{ echo "run_dir=$PI_SUBAGENT_RUN_DIR"; echo "pwd=$(pwd)"; echo "size=$(stty size)";',
		'  for arg in "$@"; do echo "arg=$arg"; done; } > "$PWD/launch.tmp"',
		'mv "$PWD/launch.tmp" "$PWD/launch.txt"',
		`sleep ${seconds}`,
	].join("\n");
}

export function makeAgentDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pi-subagent-agent-")));
}

export function makeMetadata(agentDir: string, cwd: string, handle: string): RunMetadata {
	const runDir = join(agentDir, "subagents", handle);
	const now = new Date().toISOString();
	return {
		version: 1,
		handle,
		runDir,
		sessionFile: join(runDir, "session.jsonl"),
		cwd,
		provider: "test-provider",
		model: "test-model",
		thinking: "low",
		launchArgs: ["--tools", "read"],
		state: "starting",
		hasStarted: false,
		createdAt: now,
		updatedAt: now,
	};
}

export async function waitUntil(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

export async function readLaunchRecord(project: string): Promise<string[]> {
	const file = join(project, "launch.txt");
	await waitUntil(() => existsSync(file), 10_000, "the launcher to record its start");
	return readFileSync(file, "utf8").trim().split("\n");
}

export function rexSessionExists(sessionId: string): boolean {
	return spawnSync("rex", ["session", "inspect", sessionId], { stdio: "ignore" }).status === 0;
}

export function rexSessionLabels(): string[] {
	const result = spawnSync("rex", ["ls", "--json"], { encoding: "utf8" });
	const value = JSON.parse(result.stdout) as { sessions?: { label?: string }[] };
	return (value.sessions ?? []).map((session) => session.label ?? "");
}

/** Remove a Rex session left behind by a test. */
export function killRexSession(sessionId: string | undefined): void {
	if (sessionId) spawnSync("rex", ["kill", sessionId], { stdio: "ignore" });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	killRexSession,
	makeAgentDir,
	makeProject,
	readLaunchRecord,
	recordingLauncher,
	rexSessionExists,
	waitUntil,
} from "./helpers.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "subagent.ts");
const createdSessions: string[] = [];
after(() => createdSessions.forEach(killRexSession));

function runCli(agentDir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
	const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SESSION_ID: "parent", ...env };
	delete childEnv.PI_SUBAGENT_RUN_DIR;
	return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: childEnv });
}

function spawnRun(agentDir: string, project: string) {
	const result = runCli(agentDir, [
		"spawn",
		"--cwd",
		project,
		"--provider",
		"test-provider",
		"--model",
		"test-model",
		"--prompt",
		"hello",
	]);
	assert.equal(result.status, 0, result.stderr);
	const handle = /^Spawned (\w+)$/m.exec(result.stdout)?.[1];
	const sessionId = /^Rex session: pi-subagent-\w+ \((session:[^)]+)\)$/m.exec(result.stdout)?.[1];
	assert.ok(handle, result.stdout);
	assert.ok(sessionId, result.stdout);
	createdSessions.push(sessionId);
	return { handle, sessionId };
}

test("spawn starts the run in the Rex session it reports", async () => {
	const project = makeProject(recordingLauncher(30));
	const { handle, sessionId } = spawnRun(makeAgentDir(), project);

	assert.ok((await readLaunchRecord(project)).includes("arg=Task:"));
	const inspected = spawnSync("rex", ["session", "inspect", sessionId, "--json"], { encoding: "utf8" });
	assert.equal(JSON.parse(inspected.stdout).label, `pi-subagent-${handle}`);
});

test("status reports the Rex session of a running run", async () => {
	const agentDir = makeAgentDir();
	const project = makeProject(recordingLauncher(30));
	const { handle, sessionId } = spawnRun(agentDir, project);
	await readLaunchRecord(project);

	const result = runCli(agentDir, ["status", handle]);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, new RegExp(`^${handle}: starting `, "m"));
	assert.ok(result.stdout.includes(`Rex session: pi-subagent-${handle} (${sessionId})`), result.stdout);
});

test("stop ends the run, removes its Rex session, and deletes its run directory", async () => {
	const agentDir = makeAgentDir();
	const project = makeProject(recordingLauncher(30));
	const { handle, sessionId } = spawnRun(agentDir, project);
	await readLaunchRecord(project);

	const result = runCli(agentDir, ["stop", handle]);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(rexSessionExists(sessionId), false);
	assert.equal(existsSync(join(agentDir, "subagents", handle)), false);
});

test("send refuses a run whose process has exited", async () => {
	const agentDir = makeAgentDir();
	const { handle } = spawnRun(agentDir, makeProject("exit 0"));
	await waitUntil(
		() => runCli(agentDir, ["status", handle]).stdout.startsWith(`${handle}: exited`),
		5_000,
		"the run to exit",
	);

	const result = runCli(agentDir, ["send", handle, "hello again"]);

	assert.equal(result.status, 1);
	assert.equal(result.stderr, `${handle} is not running\n`);
});

test("spawn removes the run when Rex cannot be started", () => {
	const agentDir = makeAgentDir();

	const result = runCli(agentDir, ["spawn", "--provider", "p", "--model", "m", "--prompt", "hello"], {
		PATH: "/usr/bin:/bin",
	});

	assert.equal(result.status, 1);
	assert.match(result.stderr, /rex/);
	assert.deepEqual(readdirSync(join(agentDir, "subagents")), []);
});

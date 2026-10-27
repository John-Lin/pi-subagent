import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeRunSession, effectiveRunState, launchRun, readMetadata, showRunSession, writeMetadata } from "../shared.ts";
import {
	killRexSession,
	makeAgentDir,
	makeMetadata,
	makeProject,
	readLaunchRecord,
	recordingLauncher,
	rexSessionExists,
	rexSessionLabels,
	waitUntil,
} from "./helpers.ts";

const launchedSessions: (string | undefined)[] = [];
after(() => launchedSessions.forEach(killRexSession));

function launch(launcherBody: string, handle: string, initialArgs: string[] = []) {
	const project = makeProject(launcherBody);
	const metadata = makeMetadata(makeAgentDir(), project, handle);
	writeMetadata(metadata);
	const launched = launchRun(metadata, initialArgs);
	launchedSessions.push(launched.rexSession);
	return { project, launched };
}

test("launchRun starts the launcher in the run's directory with its run dir, terminal size, and pi arguments", async () => {
	const { project, launched } = launch(recordingLauncher(30), "aaa001", ["@/tmp/spec.md", "Task:\nhello world"]);

	assert.deepEqual(await readLaunchRecord(project), [
		`run_dir=${launched.runDir}`,
		`pwd=${project}`,
		"size=40 120",
		"arg=--session",
		`arg=${launched.sessionFile}`,
		"arg=--provider",
		"arg=test-provider",
		"arg=--model",
		"arg=test-model",
		"arg=--thinking",
		"arg=low",
		"arg=--tools",
		"arg=read",
		"arg=@/tmp/spec.md",
		"arg=Task:",
		"hello world",
	]);
});

test("launchRun records the Rex session that hosts the run", () => {
	const { launched } = launch(recordingLauncher(30), "aaa002");

	assert.match(launched.rexSession ?? "", /^session:/);
	assert.equal(readMetadata(launched.runDir)?.rexSession, launched.rexSession);
});

test("a launched run stays active until its process exits", async () => {
	const { project, launched } = launch(recordingLauncher(1), "aaa003");
	await readLaunchRecord(project);

	assert.equal(effectiveRunState(launched), "starting");
	await waitUntil(() => effectiveRunState(launched) === "exited", 10_000, "the run to be reported as exited");
});

test("a run whose launcher fails immediately is reported as exited", async () => {
	const { launched } = launch("exit 1", "aaa004");

	await waitUntil(() => effectiveRunState(launched) === "exited", 5_000, "the failed run to be reported as exited");
});

test("a run that was never launched is reported as exited", () => {
	const metadata = makeMetadata(makeAgentDir(), makeProject("exit 0"), "aaa005");
	writeMetadata(metadata);

	assert.equal(readMetadata(metadata.runDir)?.handle, "aaa005");
	assert.equal(effectiveRunState(metadata), "exited");
});

test("launchRun fails without leaving a Rex session behind when the run has no metadata", () => {
	const metadata = makeMetadata(makeAgentDir(), makeProject(recordingLauncher(30)), "aaa006");

	assert.throws(() => launchRun(metadata), /aaa006/);
	assert.ok(!rexSessionLabels().includes("pi-subagent-aaa006"));
});

test("closeRunSession ends a running run and removes its Rex session", async () => {
	const { project, launched } = launch(recordingLauncher(30), "aaa007");
	await readLaunchRecord(project);

	closeRunSession(launched);

	assert.equal(effectiveRunState(launched), "exited");
	assert.equal(rexSessionExists(launched.rexSession!), false);
});

test("closeRunSession removes the empty Rex session left after the run exited", async () => {
	const { launched } = launch("exit 0", "aaa008");
	await waitUntil(() => effectiveRunState(launched) === "exited", 5_000, "the run to exit");
	assert.equal(rexSessionExists(launched.rexSession!), true);

	closeRunSession(launched);

	assert.equal(rexSessionExists(launched.rexSession!), false);
});

test("closeRunSession ignores a run that was never launched", () => {
	const metadata = makeMetadata(makeAgentDir(), makeProject("exit 0"), "aaa009");

	assert.doesNotThrow(() => closeRunSession(metadata));
});

test("showRunSession refuses a run that was never launched", () => {
	const metadata = makeMetadata(makeAgentDir(), makeProject("exit 0"), "aaa010");

	assert.throws(() => showRunSession(metadata, "session:unused"), /aaa010 has no Rex session/);
});

const parentRexSession = process.env.REX_SESSION;
test(
	"showRunSession switches the Rex app showing the parent session to the run",
	{ skip: parentRexSession ? false : "requires running inside the Rex app" },
	async () => {
		const parent = { ...makeMetadata(makeAgentDir(), makeProject("exit 0"), "parent"), rexSession: parentRexSession };
		const { project, launched } = launch(recordingLauncher(30), "aaa011");
		await readLaunchRecord(project);

		try {
			showRunSession(launched, parentRexSession!);
		} finally {
			showRunSession(parent, parentRexSession!);
		}
	},
);

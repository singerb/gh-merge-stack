import assert from "node:assert/strict";
import { test } from "node:test";
import { GmsError } from "../src/errors.ts";
import {
	applySync,
	type BranchFacts,
	buildMergePlan,
	buildPushPlan,
	chainOf,
	classifyBranch,
	classifyPush,
	type PushFacts,
	parentOf,
} from "../src/plan.ts";
import type { Stack } from "../src/state.ts";

const stackOf = (...names: string[]): Stack => ({
	name: "s",
	createdAt: "2026-01-01T00:00:00Z",
	branches: names.map((name) => ({ name })),
});

const flat = (pairs: { parent: string; child: string }[]) => pairs.map((p) => `${p.parent}->${p.child}`);

test("chainOf puts trunk at the bottom", () => {
	assert.deepEqual(chainOf(stackOf("a", "b"), "main"), ["main", "a", "b"]);
	assert.equal(parentOf(stackOf("a", "b"), "main", "a"), "main");
	assert.equal(parentOf(stackOf("a", "b"), "main", "b"), "a");
	assert.equal(parentOf(stackOf("a", "b"), "main", "main"), null);
});

test("parentOf is positional, so a trunk that leaked into the stack cannot shift it", () => {
	// The state this guards against: `gms init --trunk b` while b was already tracked, which
	// makes chainOf ["b", "a", "b"] — indexOf would find b at 0 and report no parent at all.
	const stack = stackOf("a", "b");
	assert.deepEqual(chainOf(stack, "b"), ["b", "a", "b"]);
	assert.equal(parentOf(stack, "b", "a"), "b");
	assert.equal(parentOf(stack, "b", "b"), "a");
	assert.equal(parentOf(stack, "main", "nope"), null);
});

test("default plan walks trunk up to the current branch", () => {
	const pairs = buildMergePlan({ stack: stackOf("a", "b", "c"), trunk: "main", current: "c" });
	assert.deepEqual(flat(pairs), ["main->a", "a->b", "b->c"]);
});

test("default plan stops at the current branch, not the tip", () => {
	const pairs = buildMergePlan({ stack: stackOf("a", "b", "c"), trunk: "main", current: "b" });
	assert.deepEqual(flat(pairs), ["main->a", "a->b"]);
});

test("explicit from/to ignores trunk entirely", () => {
	const pairs = buildMergePlan({
		stack: stackOf("a", "b", "c"),
		trunk: "main",
		from: "a",
		to: "c",
		current: "c",
	});
	assert.deepEqual(flat(pairs), ["a->b", "b->c"]);
});

test("a single adjacent pair is a one-step plan", () => {
	const pairs = buildMergePlan({ stack: stackOf("a", "b"), trunk: "main", from: "a", to: "b", current: "b" });
	assert.deepEqual(flat(pairs), ["a->b"]);
});

test("from == to is rejected rather than silently doing nothing", () => {
	assert.throws(
		() => buildMergePlan({ stack: stackOf("a", "b"), trunk: "main", from: "a", to: "a", current: "a" }),
		(e: unknown) => e instanceof GmsError && /nothing to merge/.test((e as GmsError).message),
	);
});

test("downward ranges are rejected: gms only merges upward", () => {
	assert.throws(
		() => buildMergePlan({ stack: stackOf("a", "b", "c"), trunk: "main", from: "c", to: "a", current: "a" }),
		(e: unknown) => e instanceof GmsError && /only merges upward/.test((e as GmsError).message),
	);
});

test("a branch outside the stack is rejected with the chain in the hint", () => {
	assert.throws(
		() => buildMergePlan({ stack: stackOf("a", "b"), trunk: "main", to: "nope", current: "nope" }),
		(e: unknown) => e instanceof GmsError && /not in stack/.test((e as GmsError).message),
	);
});

test("an empty stack has nothing to merge", () => {
	assert.throws(() => buildMergePlan({ stack: stackOf(), trunk: "main", current: "main" }), GmsError);
});

// --- push plan --------------------------------------------------------------

test("push defaults to the bottom of the stack up to the current branch", () => {
	const stack = stackOf("a", "b", "c");
	assert.deepEqual(buildPushPlan({ stack, trunk: "main", current: "b" }), ["a", "b"]);
});

test("--to raises the ceiling, --all reaches the tip", () => {
	const stack = stackOf("a", "b", "c");
	assert.deepEqual(buildPushPlan({ stack, trunk: "main", to: "c", current: "a" }), ["a", "b", "c"]);
	assert.deepEqual(buildPushPlan({ stack, trunk: "main", all: true, current: "a" }), ["a", "b", "c"]);
});

test("--all wins over --to rather than quietly disagreeing with it", () => {
	const stack = stackOf("a", "b", "c");
	assert.deepEqual(buildPushPlan({ stack, trunk: "main", to: "a", all: true, current: "a" }), [
		"a",
		"b",
		"c",
	]);
});

test("standing on trunk is not a push target: the trunk is not tracked", () => {
	assert.throws(
		() => buildPushPlan({ stack: stackOf("a", "b"), trunk: "main", current: "main" }),
		(e: unknown) => e instanceof GmsError && /not in stack/.test((e as GmsError).message),
	);
});

test("a --to outside the stack is rejected", () => {
	assert.throws(
		() => buildPushPlan({ stack: stackOf("a", "b"), trunk: "main", to: "nope", current: "a" }),
		(e: unknown) => e instanceof GmsError && /not in stack/.test((e as GmsError).message),
	);
});

test("an empty stack has nothing to push, even under --all", () => {
	assert.throws(() => buildPushPlan({ stack: stackOf(), trunk: "main", all: true, current: "a" }), GmsError);
});

// --- push classifier --------------------------------------------------------

const pushFacts = (over: Partial<PushFacts> = {}): PushFacts => ({
	localExists: true,
	remoteExists: true,
	ahead: 0,
	behind: 0,
	...over,
});

test("a branch with no remote ref is new, whatever its counts say", () => {
	assert.equal(classifyPush(pushFacts({ remoteExists: false })), "new");
	assert.equal(classifyPush(pushFacts({ remoteExists: false, behind: 3 })), "new");
});

test("commits on top of the remote are ahead", () => {
	assert.equal(classifyPush(pushFacts({ ahead: 2 })), "ahead");
});

test("matching refs are up to date", () => {
	assert.equal(classifyPush(pushFacts()), "up-to-date");
});

test("behind means the remote moved: nothing of ours to push", () => {
	assert.equal(classifyPush(pushFacts({ behind: 1 })), "behind");
});

test("ahead and behind at once is diverged, which gms refuses rather than forces", () => {
	assert.equal(classifyPush(pushFacts({ ahead: 1, behind: 1 })), "diverged");
});

test("a missing local branch is missing before anything else is considered", () => {
	assert.equal(classifyPush(pushFacts({ localExists: false, remoteExists: false })), "missing");
});

// --- classifier: one case per row of the sync table -------------------------

const facts = (over: Partial<BranchFacts> = {}): BranchFacts => ({
	localExists: true,
	remoteExists: true,
	hadUpstream: true,
	merged: false,
	hasPr: true,
	...over,
});

test("open pr with both refs present is ok", () => {
	assert.equal(classifyBranch(facts()), "ok");
});

test("pushed branch with no pr is unsubmitted", () => {
	assert.equal(classifyBranch(facts({ hasPr: false })), "unsubmitted");
});

test("merged with the remote ref still present is merged", () => {
	assert.equal(classifyBranch(facts({ merged: true })), "merged");
});

test("merged after github deleted the head branch is merged-remote-gone", () => {
	assert.equal(classifyBranch(facts({ merged: true, remoteExists: false })), "merged-remote-gone");
});

test("pruned remote without a merge is abandoned, not merged", () => {
	assert.equal(classifyBranch(facts({ remoteExists: false, merged: false })), "abandoned");
});

test("never-pushed is new, and is distinguished from pruned by upstream config", () => {
	assert.equal(classifyBranch(facts({ remoteExists: false, hadUpstream: false })), "new");
});

test("a missing local branch is gone regardless of everything else", () => {
	assert.equal(classifyBranch(facts({ localExists: false })), "gone");
	assert.equal(classifyBranch(facts({ localExists: false, merged: true })), "gone");
});

// --- applySync -------------------------------------------------------------

const classify = (m: Record<string, string>) => new Map(Object.entries(m)) as Map<string, never>;

test("merging the bottom branch re-links its child onto trunk", () => {
	const stack = stackOf("a", "b", "c");
	const out = applySync({
		stack,
		trunk: "main",
		classifications: classify({ a: "merged", b: "ok", c: "ok" }),
		prune: false,
	});
	assert.deepEqual(
		out.kept.map((b) => b.name),
		["b", "c"],
	);
	assert.deepEqual(out.relinks, [{ branch: "b", oldParent: "a", newParent: "main" }]);
});

test("merging a middle branch re-links only the branch above it", () => {
	const stack = stackOf("a", "b", "c");
	const out = applySync({
		stack,
		trunk: "main",
		classifications: classify({ a: "ok", b: "merged", c: "ok" }),
		prune: false,
	});
	assert.deepEqual(
		out.kept.map((b) => b.name),
		["a", "c"],
	);
	assert.deepEqual(out.relinks, [{ branch: "c", oldParent: "b", newParent: "a" }]);
});

test("the whole stack merging leaves it empty with no re-links", () => {
	const out = applySync({
		stack: stackOf("a", "b"),
		trunk: "main",
		classifications: classify({ a: "merged", b: "merged-remote-gone" }),
		prune: false,
	});
	assert.deepEqual(out.kept, []);
	assert.deepEqual(out.relinks, []);
});

test("gone branches survive without --prune and are dropped with it", () => {
	const args = { stack: stackOf("a", "b"), trunk: "main", classifications: classify({ a: "gone", b: "ok" }) };
	assert.deepEqual(
		applySync({ ...args, prune: false }).kept.map((b) => b.name),
		["a", "b"],
	);
	assert.deepEqual(
		applySync({ ...args, prune: true }).kept.map((b) => b.name),
		["b"],
	);
});

test("abandoned branches are never dropped, even under --prune", () => {
	const out = applySync({
		stack: stackOf("a", "b"),
		trunk: "main",
		classifications: classify({ a: "abandoned", b: "ok" }),
		prune: true,
	});
	assert.deepEqual(
		out.kept.map((b) => b.name),
		["a", "b"],
	);
});

test("an unchanged stack reports no re-links", () => {
	const out = applySync({
		stack: stackOf("a", "b", "c"),
		trunk: "main",
		classifications: classify({ a: "ok", b: "ok", c: "new" }),
		prune: false,
	});
	assert.deepEqual(out.relinks, []);
});

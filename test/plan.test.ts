import assert from "node:assert/strict";
import { test } from "node:test";
import { GmsError } from "../src/errors.ts";
import {
	applySync,
	type BranchFacts,
	buildMergePlan,
	chainOf,
	classifyBranch,
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

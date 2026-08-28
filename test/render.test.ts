import assert from "node:assert/strict";
import { test } from "node:test";
import { cell, hyperlink, pad, prCell, renderStackMarkdown, widestOf } from "../src/render.ts";
import type { TrackedBranch } from "../src/state.ts";

// Tests run piped, so isTTY is false and both color and hyperlinks are suppressed.
test("hyperlinks are suppressed when stdout is not a tty", () => {
	assert.equal(hyperlink("https://example.test/pull/1", "#1"), "#1");
});

test("prCell renders a pr number, and an em dash when there is no pr", () => {
	assert.equal(prCell(123, "https://example.test/pull/123").plain, "#123");
	assert.equal(prCell(undefined, undefined).plain, "—");
});

test("padding uses visible width, so zero-width escapes never skew a column", () => {
	// Simulates the TTY case: rendered carries escapes, plain does not.
	const linked = cell("#123", "\x1b]8;;https://x\x1b\\#123\x1b]8;;\x1b\\");
	const padded = pad(linked, 8);
	assert.ok(padded.startsWith(linked.rendered));
	assert.equal(padded.length - linked.rendered.length, 4, "pads by visible width, not string length");
});

test("widestOf measures plain text", () => {
	assert.equal(widestOf([cell("ab", "\x1b[1mab\x1b[0m"), cell("abcd")]), 4);
});

// --- markdown for pr descriptions -------------------------------------------

const md = (branches: TrackedBranch[], highlight?: string) =>
	renderStackMarkdown({ branches, trunk: "main", highlight });

const branch = (name: string, over: Partial<TrackedBranch> = {}): TrackedBranch => ({ name, ...over });

test("markdown numbers the stack bottom to top and names the base", () => {
	const out = md([
		branch("a", { pr: 1, prTitle: "Extract auth models", prUrl: "https://x/1" }),
		branch("b", { pr: 2, prTitle: "Auth API", prUrl: "https://x/2" }),
	]);
	assert.match(out, /^\*\*Stack\*\* \(bottom → top, base `main`\):$/m);
	assert.match(out, /^1\. \[#1 Extract auth models\]\(https:\/\/x\/1\)$/m);
	assert.match(out, /^2\. \[#2 Auth API\]\(https:\/\/x\/2\)$/m);
});

test("branch names never reach the markdown: trackers scrape them out of pr bodies", () => {
	const out = md([
		branch("bs/sc-4321/auth-models", { pr: 1, prTitle: "Extract auth models", prUrl: "https://x/1" }),
		branch("bs/sc-4322/auth-api"),
	]);
	assert.doesNotMatch(out, /sc-432/);
	assert.doesNotMatch(out, /auth-api/);
});

test("a pr with no cached title falls back to its number alone, never the branch", () => {
	assert.match(md([branch("a", { pr: 7, prUrl: "https://x/7" })]), /^1\. \[#7\]\(https:\/\/x\/7\)$/m);
});

test("a pr with no cached url falls back to a bare #n, which github autolinks", () => {
	assert.match(md([branch("a", { pr: 7, prTitle: "Seven" })]), /^1\. #7 Seven$/m);
});

test("a branch with no pr is a placeholder: there is no title to show and no name to leak", () => {
	assert.match(md([branch("a")]), /^1\. \*\(next layer — no PR yet\)\*$/m);
});

test("brackets in a pr title cannot break out of the link label", () => {
	const out = md([branch("a", { pr: 1, prTitle: "[infra] fix [x]", prUrl: "https://x/1" })]);
	assert.match(out, /^1\. \[#1 \\\[infra\\\] fix \\\[x\\\]\]\(https:\/\/x\/1\)$/m);
});

test("nothing is marked unless asked, so one rendering suits every pr in the stack", () => {
	assert.doesNotMatch(md([branch("a", { pr: 1 }), branch("b", { pr: 2 })]), /this PR/);
});

test("the marker lands on the named branch only", () => {
	const out = md([branch("a", { pr: 1 }), branch("b", { pr: 2, prTitle: "Bee" })], "b");
	assert.match(out, /^2\. #2 Bee 👈 \*\*this PR\*\*$/m);
	assert.match(out, /^1\. #1$/m);
});

test("markdown carries no ansi or osc escapes: it is meant to be pasted", () => {
	const out = md([branch("a", { pr: 1, prTitle: "One", prUrl: "https://x/1" })], "a");
	assert.ok(!out.includes("\u001b"), "no escape sequences in markdown output");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { indexByHead, type PrInfo } from "../src/gh.ts";
import { parseRepoSlug, type RepoState, stateFileFor, validate } from "../src/state.ts";

const stateOf = (trunk: string, stacks: Record<string, string[]>): RepoState => ({
	version: 1,
	repo: "owner/repo",
	trunk,
	stacks: Object.entries(stacks).map(([name, branches]) => ({
		name,
		createdAt: "2026-01-01T00:00:00Z",
		branches: branches.map((b) => ({ name: b })),
	})),
	pending: null,
});

test("validate is quiet about state that holds together", () => {
	assert.deepEqual(validate(stateOf("main", { one: ["a", "b"], two: ["c"] })), []);
});

test("validate catches a trunk that is also a stack member", () => {
	const warnings = validate(stateOf("b", { one: ["a", "b"] }));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] as string, /both the trunk and a member of stack 'one'/);
});

test("validate catches a branch tracked twice", () => {
	assert.match(
		validate(stateOf("main", { one: ["a"], two: ["a"] }))[0] as string,
		/tracked in both 'one' and 'two'/,
	);
	assert.match(validate(stateOf("main", { one: ["a", "a"] }))[0] as string, /appears twice in stack 'one'/);
});

test("parseRepoSlug handles the remote url forms git actually produces", () => {
	const cases: [string, string | null][] = [
		["git@github.com:owner/repo.git", "owner/repo"],
		["git@github.com:owner/repo", "owner/repo"],
		["https://github.com/owner/repo.git", "owner/repo"],
		["https://github.com/owner/repo", "owner/repo"],
		["ssh://git@github.com/owner/repo.git", "owner/repo"],
		["https://user:token@github.com/owner/repo.git", "owner/repo"],
		["git@github.enterprise.internal:team/sub/repo.git", "sub/repo"],
		["  git@github.com:owner/repo.git\n", "owner/repo"],
		// Non-URL remotes fall back to the last two path components.
		["/srv/git/team/repo.git", "team/repo"],
		["file:///srv/git/team/repo.git", "team/repo"],
		["../sibling/origin.git", "sibling/origin"],
		["not-a-url", null],
		["https://github.com/owner", null],
		["", null],
	];
	for (const [url, expected] of cases) {
		assert.equal(parseRepoSlug(url), expected, url);
	}
});

test("state file names are filesystem-safe and stable", () => {
	const file = stateFileFor("owner/repo");
	assert.match(file, /owner__repo\.json$/);
	assert.equal(stateFileFor("owner/repo"), file);
	assert.match(stateFileFor("o w/n er"), /o__w__n__er\.json$/);
});

const pr = (over: Partial<PrInfo>): PrInfo => ({
	number: 1,
	state: "OPEN",
	headRefName: "feat",
	baseRefName: "main",
	url: "https://example.test/pull/1",
	title: "t",
	...over,
});

test("indexByHead keys prs by their head branch", () => {
	const map = indexByHead([pr({ number: 7, headRefName: "a" }), pr({ number: 8, headRefName: "b" })]);
	assert.equal(map.get("a")?.number, 7);
	assert.equal(map.get("b")?.number, 8);
});

test("an open pr wins over a closed one on the same branch", () => {
	const map = indexByHead([
		pr({ number: 9, state: "CLOSED", headRefName: "a" }),
		pr({ number: 3, state: "OPEN", headRefName: "a" }),
	]);
	assert.equal(map.get("a")?.number, 3);
});

test("a merged pr wins over a closed one", () => {
	const map = indexByHead([
		pr({ number: 9, state: "CLOSED", headRefName: "a" }),
		pr({ number: 3, state: "MERGED", headRefName: "a" }),
	]);
	assert.equal(map.get("a")?.number, 3);
});

test("among equal states the newest pr number wins", () => {
	const map = indexByHead([
		pr({ number: 3, state: "MERGED", headRefName: "a" }),
		pr({ number: 11, state: "MERGED", headRefName: "a" }),
	]);
	assert.equal(map.get("a")?.number, 11);
});

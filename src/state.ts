import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail } from "./errors.ts";
import type { Git } from "./git.ts";

export const STATE_VERSION = 1;

export type PrState = "OPEN" | "CLOSED" | "MERGED";

export type TrackedBranch = {
	name: string;
	/** Cache refreshed by `gms sync`; nothing depends on these being fresh or present. */
	pr?: number;
	prState?: PrState;
	prBase?: string;
	prUrl?: string;
	prTitle?: string;
};

export type Stack = {
	name: string;
	createdAt: string;
	branches: TrackedBranch[];
};

/** An interrupted `gms merge` walk, so `--continue` knows exactly where to pick up. */
export type Pending = {
	stack: string;
	pairs: { parent: string; child: string }[];
	/** Number of pairs already completed; the walk resumes at `pairs[doneCount]`. */
	doneCount: number;
	/** Branches whose SHA changed so far, in walk order; pushed together at the end. */
	changed: string[];
	startedOn: string;
	push: boolean;
};

export type RepoState = {
	version: number;
	repo: string;
	trunk: string;
	stacks: Stack[];
	pending: Pending | null;
};

export type Config = {
	defaultTrunk?: string;
	remote?: string;
};

function xdg(envVar: string, fallback: string): string {
	const v = process.env[envVar];
	return v && v.length > 0 ? v : join(homedir(), fallback);
}

export const configDir = () => join(xdg("XDG_CONFIG_HOME", ".config"), "gms");
export const dataDir = () => join(xdg("XDG_DATA_HOME", ".local/share"), "gms");
export const stacksDir = () => join(dataDir(), "stacks");

export function loadConfig(): Config {
	const file = join(configDir(), "config.json");
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Config;
	} catch (err) {
		fail(`could not parse ${file}`, String(err));
	}
}

/**
 * Reduce a remote URL to an `owner/repo` key. Handles the scp-style ssh form
 * (`git@host:owner/repo.git`), full ssh/https URLs, and a missing `.git` suffix.
 *
 * A remote that is not a recognisable URL (a local path, a `file://` clone) falls back to the
 * last two path components. That keeps `init`/`add`/`merge` usable against non-GitHub remotes;
 * only `sync` needs the key to be a real GitHub slug, and it fails loudly if it is not.
 */
export function parseRepoSlug(url: string): string | null {
	const trimmed = url
		.trim()
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	if (trimmed.length === 0) return null;
	const scp = trimmed.match(/^[^@/]+@[^:/]+:(.+)$/);
	const scheme = trimmed.match(/^[a-z+]+:\/\/(?:[^@/]*@)?[^/]+\/(.+)$/i);
	const path = scp?.[1] ?? scheme?.[1] ?? trimmed;
	const parts = path.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Key state by `owner/repo`, not by path: every `trustlayer-cwt-*` worktree resolves to one
 * file, and moving a clone does not orphan its stacks.
 */
export function repoSlug(git: Git, remote = "origin"): string {
	const r = git.run(["remote", "get-url", remote]);
	if (!r.ok)
		fail(`no '${remote}' remote in ${git.root}`, "gms keys its state by the origin remote's owner/repo");
	const slug = parseRepoSlug(r.stdout);
	if (!slug) fail(`could not parse owner/repo from ${remote} url: ${r.stdout}`);
	return slug;
}

export const stateFileFor = (slug: string) =>
	join(stacksDir(), `${slug.replace(/[^A-Za-z0-9._-]+/g, "__")}.json`);

function migrate(raw: RepoState, file: string): RepoState {
	if (raw.version > STATE_VERSION) {
		fail(
			`${file} was written by a newer gms (version ${raw.version}, this build understands ${STATE_VERSION})`,
			"update gms, or move the file aside to start over",
		);
	}
	return raw;
}

/**
 * Hand-editing the state file is supported, and `gms trunk` can only repair a broken trunk
 * if it still runs — so these warn on stderr and never fail. stderr keeps `ls --json` clean.
 */
export function validate(state: RepoState): string[] {
	const warnings: string[] = [];
	const seen = new Map<string, string>();

	for (const stack of state.stacks) {
		for (const branch of stack.branches) {
			if (branch.name === state.trunk) {
				warnings.push(`'${branch.name}' is both the trunk and a member of stack '${stack.name}'`);
			}
			const prior = seen.get(branch.name);
			if (prior !== undefined) {
				warnings.push(
					prior === stack.name
						? `'${branch.name}' appears twice in stack '${stack.name}'`
						: `'${branch.name}' is tracked in both '${prior}' and '${stack.name}'`,
				);
			} else {
				seen.set(branch.name, stack.name);
			}
		}
	}
	return warnings;
}

export function emptyState(slug: string, trunk: string): RepoState {
	return { version: STATE_VERSION, repo: slug, trunk, stacks: [], pending: null };
}

export function loadState(slug: string, trunk: string): RepoState {
	const file = stateFileFor(slug);
	if (!existsSync(file)) return emptyState(slug, trunk);
	let raw: RepoState;
	try {
		raw = JSON.parse(readFileSync(file, "utf8")) as RepoState;
	} catch (err) {
		fail(`could not parse ${file}`, String(err), "fix it by hand or move it aside");
	}
	const state = migrate(raw, file);
	for (const warning of validate(state)) {
		console.error(`warning: ${warning}`);
	}
	return state;
}

/** Atomic: write a sibling temp file, then rename over the target. */
export function saveState(state: RepoState): void {
	const file = stateFileFor(state.repo);
	mkdirSync(stacksDir(), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

export function listStateFiles(): string[] {
	const dir = stacksDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => join(dir, f));
}

export function findStack(state: RepoState, name: string): Stack {
	const stack = state.stacks.find((s) => s.name === name);
	if (!stack) fail(`no stack named '${name}' in ${state.repo}`, "gms stacks — list known stacks");
	return stack;
}

/** The stack containing `branch`, or null. A branch belongs to at most one stack. */
export function stackForBranch(state: RepoState, branch: string): Stack | null {
	return state.stacks.find((s) => s.branches.some((b) => b.name === branch)) ?? null;
}

/**
 * Resolve which stack a command should act on: an explicit `--stack`, else the stack holding
 * the current branch, else the only stack if there is exactly one.
 */
export function resolveStack(state: RepoState, explicit: string | undefined, current: string): Stack {
	if (explicit) return findStack(state, explicit);
	const byBranch = stackForBranch(state, current);
	if (byBranch) return byBranch;
	if (state.stacks.length === 1 && state.stacks[0]) return state.stacks[0];
	if (state.stacks.length === 0) fail(`no stacks tracked for ${state.repo}`, "gms init <name> — start one");
	fail(`'${current}' is not in any stack and ${state.repo} has several`, "pass --stack <name>");
}

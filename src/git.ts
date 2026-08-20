import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fail } from "./errors.ts";

export type GitResult = { ok: boolean; stdout: string; stderr: string };

/** In-progress operations that make it unsafe to start a merge walk. */
export type InProgressOp = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export interface Git {
	/** Absolute path to the working tree we operate on. Every call uses `git -C root`. */
	readonly root: string;
	run(args: string[]): GitResult;
	must(args: string[]): string;
	currentBranch(): string;
	branchExists(branch: string): boolean;
	remoteRefExists(branch: string): boolean;
	/** True when the branch has upstream config, regardless of whether the remote ref survives. */
	hasUpstreamConfig(branch: string): boolean;
	isAncestor(maybeAncestor: string, descendant: string): boolean;
	isDirty(): boolean;
	inProgressOp(): InProgressOp | null;
	/** Commits on `branch` not on `base` (ahead) and on `base` not on `branch` (behind). */
	aheadBehind(branch: string, base: string): { ahead: number; behind: number };
	revParse(ref: string): string | null;
	/** Path of a *different* worktree that currently has `branch` checked out, if any. */
	otherWorktreeFor(branch: string): string | null;
	gitPath(name: string): string;
}

function exec(root: string | null, args: string[]): GitResult {
	const full = root === null ? args : ["-C", root, ...args];
	try {
		const stdout = execFileSync("git", full, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 32 * 1024 * 1024,
		});
		return { ok: true, stdout: stdout.trim(), stderr: "" };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: string };
		if (e.code === "ENOENT") fail("git not found on PATH");
		return {
			ok: false,
			stdout: (e.stdout ?? "").trim(),
			stderr: (e.stderr ?? "").trim(),
		};
	}
}

/** Resolve the working tree root from `cwd`, erroring out when we are not in a repo. */
export function createGit(cwd: string = process.cwd()): Git {
	const top = exec(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok) fail("not inside a git repository");
	return gitAt(top.stdout);
}

export function gitAt(root: string): Git {
	const run = (args: string[]) => exec(root, args);

	const must = (args: string[]) => {
		const r = run(args);
		if (!r.ok) fail(`git ${args.join(" ")} failed`, r.stderr || "(no stderr)");
		return r.stdout;
	};

	const gitPath = (name: string) => must(["rev-parse", "--git-path", name]);

	return {
		root,
		run,
		must,
		gitPath,

		currentBranch() {
			const r = run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
			if (!r.ok) fail("HEAD is detached; check out a branch first");
			return r.stdout;
		},

		branchExists(branch) {
			return run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
		},

		remoteRefExists(branch) {
			return run(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).ok;
		},

		hasUpstreamConfig(branch) {
			return run(["config", "--get", `branch.${branch}.remote`]).ok;
		},

		isAncestor(maybeAncestor, descendant) {
			return run(["merge-base", "--is-ancestor", maybeAncestor, descendant]).ok;
		},

		isDirty() {
			return must(["status", "--porcelain"]).length > 0;
		},

		inProgressOp() {
			if (existsSync(gitPath("MERGE_HEAD"))) return "merge";
			if (existsSync(gitPath("rebase-merge")) || existsSync(gitPath("rebase-apply"))) return "rebase";
			if (existsSync(gitPath("CHERRY_PICK_HEAD"))) return "cherry-pick";
			if (existsSync(gitPath("REVERT_HEAD"))) return "revert";
			if (existsSync(gitPath("BISECT_LOG"))) return "bisect";
			return null;
		},

		aheadBehind(branch, base) {
			// `--left-right --count base...branch` prints "<base-only> <branch-only>",
			// i.e. how far `branch` is behind, then how far it is ahead.
			const r = run(["rev-list", "--left-right", "--count", `${base}...${branch}`]);
			if (!r.ok) return { ahead: 0, behind: 0 };
			const [behind = "0", ahead = "0"] = r.stdout.split(/\s+/);
			return { ahead: Number(ahead), behind: Number(behind) };
		},

		revParse(ref) {
			const r = run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
			return r.ok && r.stdout ? r.stdout : null;
		},

		otherWorktreeFor(branch) {
			const out = must(["worktree", "list", "--porcelain"]);
			let path: string | null = null;
			for (const line of out.split("\n")) {
				if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
				else if (line === `branch refs/heads/${branch}` && path && path !== root) return path;
			}
			return null;
		},
	};
}

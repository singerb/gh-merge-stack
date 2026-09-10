import { GmsError } from "./errors.ts";
import type { Stack, TrackedBranch } from "./state.ts";

export type MergePair = { parent: string; child: string };

/** trunk first, then the stack bottom-to-top. `chain[i]` is the parent of `chain[i + 1]`. */
export function chainOf(stack: Stack, trunk: string): string[] {
	return [trunk, ...stack.branches.map((b) => b.name)];
}

/** Positional, like `chainOf` — a duplicate name in the chain must not shift the answer. */
export function parentOf(stack: Stack, trunk: string, branch: string): string | null {
	const i = stack.branches.findIndex((b) => b.name === branch);
	if (i === -1) return null;
	return i === 0 ? trunk : (stack.branches[i - 1]?.name ?? null);
}

/**
 * Args for `pnpm changeset` on `branch`. A changeset should describe only the commits that
 * belong to this branch, so everything above the bottom of the stack gets `--since <parent>`;
 * the bottom branch already diffs against the trunk on its own.
 */
export function changesetArgs(args: { stack: Stack; trunk: string; branch: string }): string[] {
	const { stack, trunk, branch } = args;
	const parent = parentOf(stack, trunk, branch);
	if (parent === null) {
		throw new GmsError(
			`'${branch}' is not in stack '${stack.name}'`,
			`stack runs: ${chainOf(stack, trunk).join(" -> ")}`,
		);
	}
	return parent === trunk ? ["changeset"] : ["changeset", "--since", parent];
}

/**
 * Ordered parent -> child pairs for the slice of the stack between `from` and `to`.
 * Defaults: `from` = trunk, `to` = the current branch.
 */
export function buildMergePlan(args: {
	stack: Stack;
	trunk: string;
	from?: string;
	to?: string;
	current: string;
}): MergePair[] {
	const { stack, trunk, current } = args;
	const chain = chainOf(stack, trunk);
	const from = args.from ?? trunk;
	const to = args.to ?? current;

	const fromIdx = chain.indexOf(from);
	const toIdx = chain.indexOf(to);

	if (fromIdx === -1) {
		throw new GmsError(`'${from}' is not in stack '${stack.name}'`, `stack runs: ${chain.join(" -> ")}`);
	}
	if (toIdx === -1) {
		const hint =
			to === current
				? `you are on '${current}', which is not in stack '${stack.name}' — pass --to <branch>`
				: `stack runs: ${chain.join(" -> ")}`;
		throw new GmsError(`'${to}' is not in stack '${stack.name}'`, hint);
	}
	if (toIdx === fromIdx) {
		throw new GmsError(`nothing to merge: --from and --to are both '${from}'`);
	}
	if (toIdx < fromIdx) {
		throw new GmsError(
			`'${to}' is below '${from}' in the stack; gms only merges upward`,
			`stack runs: ${chain.join(" -> ")}`,
			`did you mean --from ${to} --to ${from}?`,
		);
	}

	const pairs: MergePair[] = [];
	for (let i = fromIdx; i < toIdx; i++) {
		pairs.push({ parent: chain[i] as string, child: chain[i + 1] as string });
	}
	return pairs;
}

/** How `gms push` sees a tracked branch, from local refs alone — no fetch, no network. */
export type PushState = "new" | "ahead" | "up-to-date" | "behind" | "diverged" | "missing";

export type PushFacts = {
	localExists: boolean;
	remoteExists: boolean;
	/** Ahead of / behind `origin/<branch>`; both zero when there is nothing to compare against. */
	ahead: number;
	behind: number;
};

export function classifyPush(f: PushFacts): PushState {
	if (!f.localExists) return "missing";
	if (!f.remoteExists) return "new";
	if (f.ahead > 0 && f.behind > 0) return "diverged";
	if (f.ahead > 0) return "ahead";
	if (f.behind > 0) return "behind";
	return "up-to-date";
}

/** Classifications with commits to publish. Everything else is reported and left alone. */
export const PUSHABLE: ReadonlySet<PushState> = new Set(["new", "ahead"]);

/**
 * The slice of the stack to publish: bottom-up to `to`, which defaults to the branch you are on
 * exactly as `gms merge` does. `all` reaches the tip instead.
 */
export function buildPushPlan(args: {
	stack: Stack;
	trunk: string;
	to?: string;
	all?: boolean;
	current: string;
}): string[] {
	const { stack, trunk, current } = args;
	const names = stack.branches.map((b) => b.name);
	if (names.length === 0) {
		throw new GmsError(`stack '${stack.name}' is empty`, "gms add <branch> — put something in it");
	}
	if (args.all) return names;

	const to = args.to ?? current;
	const idx = names.indexOf(to);
	if (idx === -1) {
		const chain = chainOf(stack, trunk);
		const hint =
			to === trunk
				? `'${trunk}' is the trunk — gms only pushes branches it tracks; try --all`
				: to === current
					? `you are on '${current}', which is not in stack '${stack.name}' — pass --to <branch> or --all`
					: `stack runs: ${chain.join(" -> ")}`;
		throw new GmsError(`'${to}' is not in stack '${stack.name}'`, hint);
	}
	return names.slice(0, idx + 1);
}

/** How `gms sync` sees a tracked branch after fetching. */
export type Classification =
	| "merged"
	| "merged-remote-gone"
	| "abandoned"
	| "new"
	| "gone"
	| "unsubmitted"
	| "ok";

export type BranchFacts = {
	localExists: boolean;
	remoteExists: boolean;
	/** Had upstream config, so a missing remote ref means `fetch --prune` removed it. */
	hadUpstream: boolean;
	merged: boolean;
	hasPr: boolean;
};

export function classifyBranch(f: BranchFacts): Classification {
	if (!f.localExists) return "gone";
	if (f.remoteExists) {
		if (f.merged) return "merged";
		return f.hasPr ? "ok" : "unsubmitted";
	}
	// No remote ref. Either it was pruned, or it was never pushed.
	if (!f.hadUpstream) return "new";
	if (f.merged) return "merged-remote-gone";
	return "abandoned";
}

/** Classifications that mean the branch has landed and should leave the stack. */
export const MERGED_KINDS: ReadonlySet<Classification> = new Set(["merged", "merged-remote-gone"]);

export type SyncDecision = {
	branch: TrackedBranch;
	classification: Classification;
	/** Whether this branch leaves the stack in this run. */
	removed: boolean;
};

export type Relink = { branch: string; oldParent: string; newParent: string };

export type SyncOutcome = {
	decisions: SyncDecision[];
	kept: TrackedBranch[];
	relinks: Relink[];
};

/**
 * Decide the new stack contents. Merged branches always leave; `gone` branches leave only
 * under `--prune`, and `abandoned` branches never leave automatically — they are the one case
 * where a local-only commit could be lost.
 */
export function applySync(args: {
	stack: Stack;
	trunk: string;
	classifications: Map<string, Classification>;
	prune: boolean;
}): SyncOutcome {
	const { stack, trunk, classifications, prune } = args;
	const decisions: SyncDecision[] = [];

	for (const branch of stack.branches) {
		const classification = classifications.get(branch.name) ?? "ok";
		const removed = MERGED_KINDS.has(classification) || (classification === "gone" && prune);
		decisions.push({ branch, classification, removed });
	}

	const kept = decisions.filter((d) => !d.removed).map((d) => d.branch);

	// Because stacks are linear, dropping entries *is* the re-link; report the parent changes.
	const relinks: Relink[] = [];
	let newParent = trunk;
	for (const branch of stack.branches) {
		const decision = decisions.find((d) => d.branch.name === branch.name);
		if (decision?.removed) continue;
		const oldParent = parentOf(stack, trunk, branch.name) ?? trunk;
		if (oldParent !== newParent) {
			relinks.push({ branch: branch.name, oldParent, newParent });
		}
		newParent = branch.name;
	}

	return { decisions, kept, relinks };
}

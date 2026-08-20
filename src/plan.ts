import { GmsError } from "./errors.ts";
import type { Stack, TrackedBranch } from "./state.ts";

export type MergePair = { parent: string; child: string };

/** trunk first, then the stack bottom-to-top. `chain[i]` is the parent of `chain[i + 1]`. */
export function chainOf(stack: Stack, trunk: string): string[] {
	return [trunk, ...stack.branches.map((b) => b.name)];
}

export function parentOf(stack: Stack, trunk: string, branch: string): string | null {
	const chain = chainOf(stack, trunk);
	const i = chain.indexOf(branch);
	return i > 0 ? (chain[i - 1] ?? null) : null;
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

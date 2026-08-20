import { type Ctx, openRepo } from "../context.ts";
import { listPrs, type PrInfo } from "../gh.ts";
import { applySync, type BranchFacts, type Classification, classifyBranch, parentOf } from "../plan.ts";
import { classificationLabel, classificationStyle, renderRelinks, style } from "../render.ts";
import type { Stack, TrackedBranch } from "../state.ts";

export type SyncArgs = {
	stack?: string;
	dryRun?: boolean;
	prune?: boolean;
	keepEmpty?: boolean;
};

export function sync(args: SyncArgs): void {
	const ctx = openRepo();
	const { git, state } = ctx;
	const dryRun = args.dryRun === true;
	const prune = args.prune === true;

	console.log(
		`syncing ${style(state.repo, "bold")} (trunk: ${style(state.trunk, "cyan")})${dryRun ? style("  [dry run]", "dim") : ""}`,
	);

	// The --prune here is what makes "remote branch is gone" a meaningful signal below.
	git.must(["fetch", "--prune", "origin"]);
	const prs = listPrs(state.repo);

	const targets = args.stack ? state.stacks.filter((s) => s.name === args.stack) : state.stacks;
	if (targets.length === 0) {
		console.log(args.stack ? `no stack named '${args.stack}'` : `no stacks tracked for ${state.repo}`);
		return;
	}

	const toDelete: string[] = [];
	const baseFixes: string[] = [];

	for (const stack of targets) {
		syncStack(ctx, stack, prs, { prune, toDelete, baseFixes });
	}

	if (!args.keepEmpty) {
		const emptied = state.stacks.filter((s) => s.branches.length === 0).map((s) => s.name);
		if (emptied.length > 0) {
			state.stacks = state.stacks.filter((s) => s.branches.length > 0);
			console.log("");
			for (const name of emptied) console.log(`dropped empty stack ${style(name, "bold")}`);
		}
	}

	if (baseFixes.length > 0) {
		console.log("");
		console.log(
			"pr bases no longer match the stack. gms does not edit PRs — run these if you want them fixed:",
		);
		for (const cmd of baseFixes) console.log(`  ${style(cmd, "bold")}`);
		console.log(
			`  ${style("often unnecessary: github retargets automatically when a merged base branch is deleted", "dim")}`,
		);
	}

	if (toDelete.length > 0) {
		console.log("");
		if (prune && !dryRun) {
			for (const branch of toDelete) deleteBranch(ctx, branch);
		} else if (prune && dryRun) {
			for (const branch of toDelete)
				console.log(`would delete local branch ${style(branch, "bold")} (git branch -d)`);
		} else {
			console.log("local branches that have landed and can be deleted:");
			for (const branch of toDelete)
				console.log(`  ${style(`git -C ${git.root} branch -d ${branch}`, "bold")}`);
			console.log(`  ${style("or re-run with --prune to let gms do it (safe -d only)", "dim")}`);
		}
	}

	if (dryRun) {
		console.log("");
		console.log(style("dry run: nothing was changed", "dim"));
		return;
	}
	ctx.save();
}

function syncStack(
	ctx: Ctx,
	stack: Stack,
	prs: Map<string, PrInfo>,
	out: { prune: boolean; toDelete: string[]; baseFixes: string[] },
): void {
	const { git, state } = ctx;
	const classifications = new Map<string, Classification>();
	const facts = new Map<string, BranchFacts>();

	for (const branch of stack.branches) {
		const pr = prs.get(branch.name);
		const localExists = git.branchExists(branch.name);
		const remoteExists = git.remoteRefExists(branch.name);
		const mergedByAncestry =
			localExists && git.remoteRefExists(state.trunk)
				? git.isAncestor(branch.name, `origin/${state.trunk}`)
				: false;

		const f: BranchFacts = {
			localExists,
			remoteExists,
			hadUpstream: git.hasUpstreamConfig(branch.name),
			merged: pr?.state === "MERGED" || mergedByAncestry,
			hasPr: pr !== undefined,
		};
		facts.set(branch.name, f);
		classifications.set(branch.name, classifyBranch(f));
		cachePr(branch, pr);
	}

	const outcome = applySync({ stack, trunk: state.trunk, classifications, prune: out.prune });

	console.log("");
	console.log(`stack ${style(stack.name, "bold")}`);
	const width = Math.max(...stack.branches.map((b) => b.name.length), 1);

	for (const d of outcome.decisions) {
		const label = classificationLabel(d.classification);
		const suffix = d.removed
			? style(" -> untracked", "dim")
			: d.classification === "gone"
				? style("  (re-run with --prune to untrack)", "dim")
				: d.classification === "abandoned"
					? style("  (left alone: it may hold commits that exist nowhere else)", "dim")
					: "";
		const pr = d.branch.pr ? ` #${d.branch.pr}` : "";
		console.log(
			`  ${d.branch.name.padEnd(width)}${pr.padEnd(7)} ${style(label, ...classificationStyle(d.classification))}${suffix}`,
		);

		if (d.removed && facts.get(d.branch.name)?.localExists && d.classification !== "gone") {
			out.toDelete.push(d.branch.name);
		}
	}

	stack.branches = outcome.kept;
	for (const line of renderRelinks(outcome.relinks)) console.log(line);

	// Report-only: the read-only stance means gms never runs `gh pr edit` itself.
	for (const branch of stack.branches) {
		if (branch.pr === undefined || branch.prState !== "OPEN") continue;
		const expected = parentOf(stack, state.trunk, branch.name);
		if (expected && branch.prBase && branch.prBase !== expected) {
			out.baseFixes.push(`gh pr edit ${branch.pr} --repo ${state.repo} --base ${expected}`);
		}
	}
}

function cachePr(branch: TrackedBranch, pr: PrInfo | undefined): void {
	if (!pr) {
		branch.pr = undefined;
		branch.prState = undefined;
		branch.prBase = undefined;
		branch.prUrl = undefined;
		return;
	}
	branch.pr = pr.number;
	branch.prState = pr.state;
	branch.prBase = pr.baseRefName;
	branch.prUrl = pr.url;
}

/** Safe delete only. `-D` is deliberately not reachable from anywhere in gms. */
function deleteBranch(ctx: Ctx, branch: string): void {
	const { git } = ctx;
	if (git.currentBranch() === branch) {
		console.log(`${style("skipped", "yellow")} deleting ${branch}: it is checked out here`);
		return;
	}
	const other = git.otherWorktreeFor(branch);
	if (other) {
		console.log(`${style("skipped", "yellow")} deleting ${branch}: checked out in ${other}`);
		return;
	}
	const r = git.run(["branch", "-d", branch]);
	if (r.ok) console.log(`deleted local branch ${style(branch, "bold")}`);
	else console.log(`${style("skipped", "yellow")} deleting ${branch}: ${r.stderr.split("\n")[0]}`);
}

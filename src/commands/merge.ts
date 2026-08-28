import { type Ctx, openRepo } from "../context.ts";
import { fail } from "../errors.ts";
import { buildMergePlan, type MergePair } from "../plan.ts";
import { pushArgsFor, pushBranches } from "../push.ts";
import { renderMergePlan, style } from "../render.ts";
import { type Pending, resolveStack } from "../state.ts";

export type MergeArgs = {
	from?: string;
	to?: string;
	stack?: string;
	dryRun?: boolean;
	noPush?: boolean;
	continue?: boolean;
	abort?: boolean;
};

export function merge(args: MergeArgs): void {
	const ctx = openRepo();
	if (args.abort) {
		abort(ctx);
		return;
	}
	if (args.continue) {
		resume(ctx);
		return;
	}

	const { git, state } = ctx;
	if (state.pending) {
		fail(
			`a merge walk on stack '${state.pending.stack}' is unfinished`,
			"gms merge --continue — resume it after committing the resolution",
			"gms merge --abort — back out of the in-flight merge",
		);
	}

	const startedOn = git.currentBranch();
	const stack = resolveStack(state, args.stack, startedOn);
	const pairs = buildMergePlan({
		stack,
		trunk: state.trunk,
		from: args.from,
		to: args.to,
		current: startedOn,
	});

	console.log(renderMergePlan(pairs));
	if (args.dryRun) return;

	preflight(ctx, pairs, startedOn);

	// Merge the *remote* trunk so a local `git pull` is never a prerequisite.
	if (pairs[0]?.parent === state.trunk) {
		console.log(`fetching origin ${state.trunk}`);
		git.must(["fetch", "origin", state.trunk]);
	}

	const pending: Pending = {
		stack: stack.name,
		pairs,
		doneCount: 0,
		changed: [],
		startedOn,
		push: args.noPush !== true,
	};
	walk(ctx, pending);
}

/** Everything is checked before anything is touched: a refused merge changes nothing. */
function preflight(ctx: Ctx, pairs: MergePair[], startedOn: string): void {
	const { git, state } = ctx;

	if (git.isDirty()) {
		fail("working tree is dirty", "commit or stash before merging up the stack");
	}
	const op = git.inProgressOp();
	if (op) fail(`a ${op} is already in progress in ${git.root}`, `finish or abort it first`);

	for (const pair of pairs) {
		if (!git.branchExists(pair.child)) {
			fail(
				`no local branch named '${pair.child}'`,
				"gms sync — reconcile the stack with what actually exists",
			);
		}
		// A branch checked out in another worktree cannot be switched to here.
		const other = git.otherWorktreeFor(pair.child);
		if (other && pair.child !== startedOn) {
			fail(
				`'${pair.child}' is checked out in another worktree: ${other}`,
				"switch that worktree off the branch first",
			);
		}
	}

	const first = pairs[0];
	if (first && first.parent !== state.trunk && !git.branchExists(first.parent)) {
		fail(`no local branch named '${first.parent}'`);
	}
}

/** Source ref for a step — the remote trunk when merging from trunk, else the local parent. */
function sourceRef(parent: string, trunk: string, ctx: Ctx): string {
	if (parent === trunk && ctx.git.remoteRefExists(trunk)) return `origin/${trunk}`;
	return parent;
}

function walk(ctx: Ctx, pending: Pending): void {
	const { git, state } = ctx;

	for (let i = pending.doneCount; i < pending.pairs.length; i++) {
		const pair = pending.pairs[i] as MergePair;
		const source = sourceRef(pair.parent, state.trunk, ctx);

		if (git.isAncestor(source, pair.child)) {
			console.log(`  ${style("=", "dim")} ${pair.child} is already up to date with ${pair.parent}`);
			pending.doneCount = i + 1;
			continue;
		}

		git.must(["switch", pair.child]);
		const before = git.revParse(pair.child);
		const result = git.run(["merge", "--no-edit", source]);

		if (!result.ok) {
			if (git.inProgressOp() === "merge") {
				pending.doneCount = i;
				state.pending = pending;
				ctx.save();
				reportConflict(ctx, pair, source);
			}
			// Not a conflict (unrelated histories, hook rejection, ...): nothing to resume.
			fail(`merging ${source} into ${pair.child} failed`, result.stderr || "(no stderr)");
		}

		const after = git.revParse(pair.child);
		if (before !== after && !pending.changed.includes(pair.child)) pending.changed.push(pair.child);
		console.log(`  ${style("✓", "green")} merged ${style(source, "cyan")} into ${style(pair.child, "bold")}`);
		pending.doneCount = i + 1;
	}

	finish(ctx, pending);
}

function reportConflict(ctx: Ctx, pair: MergePair, source: string): never {
	const conflicted = ctx.git.run(["diff", "--name-only", "--diff-filter=U"]).stdout;
	const files = conflicted ? conflicted.split("\n") : [];

	console.error("");
	console.error(style(`conflict merging ${source} into ${pair.child}`, "yellow"));
	for (const f of files) console.error(`  ${f}`);
	console.error("");
	console.error("nothing has been pushed. you are on the conflicted branch. to carry on:");
	console.error(`  resolve the files above, then ${style("git add <files>", "bold")}`);
	console.error(`  ${style("git commit", "bold")}`);
	console.error(`  ${style("gms merge --continue", "bold")}`);
	console.error(`or ${style("gms merge --abort", "bold")} to back out of this one merge.`);
	process.exit(1);
}

function resume(ctx: Ctx): void {
	const { git, state } = ctx;
	const pending = state.pending;
	if (!pending) fail("no merge walk to continue");

	if (git.inProgressOp() === "merge") {
		fail("the merge is still in progress", "resolve the conflicts, `git add` them, then `git commit`");
	}
	if (git.isDirty()) fail("working tree is dirty", "commit the resolution before continuing");

	const pair = pending.pairs[pending.doneCount];
	if (!pair) {
		// Nothing left to do; just wrap up.
		finish(ctx, pending);
		return;
	}

	const current = git.currentBranch();
	if (current !== pair.child) {
		fail(
			`the interrupted merge was on '${pair.child}' but you are on '${current}'`,
			`git switch ${pair.child}`,
		);
	}

	if (!pending.changed.includes(pair.child)) pending.changed.push(pair.child);
	console.log(`  ${style("✓", "green")} resolved merge into ${style(pair.child, "bold")}`);
	pending.doneCount += 1;
	walk(ctx, pending);
}

function abort(ctx: Ctx): void {
	const { git, state } = ctx;
	const pending = state.pending;
	if (!pending) fail("no merge walk to abort");

	if (git.inProgressOp() === "merge") {
		git.must(["merge", "--abort"]);
		console.log("aborted the in-flight merge");
	}
	if (git.currentBranch() !== pending.startedOn && git.branchExists(pending.startedOn)) {
		git.must(["switch", pending.startedOn]);
		console.log(`switched back to ${style(pending.startedOn, "bold")}`);
	}

	state.pending = null;
	ctx.save();

	if (pending.changed.length > 0) {
		console.log("");
		console.log(
			`${style("note:", "yellow")} these branches were merged earlier in the walk and are left as-is:`,
		);
		for (const b of pending.changed) console.log(`  ${b}`);
		console.log(`  ${style("they were not pushed and were not reverted", "dim")}`);
	}
}

function finish(ctx: Ctx, pending: Pending): void {
	const { git, state } = ctx;
	state.pending = null;
	ctx.save();

	if (git.currentBranch() !== pending.startedOn && git.branchExists(pending.startedOn)) {
		git.must(["switch", pending.startedOn]);
	}

	if (pending.changed.length === 0) {
		console.log("nothing to push; the stack was already up to date");
		return;
	}

	// Merging is local until you say otherwise: a branch with no remote ref was either never
	// pushed or was deleted there, and neither is ours to publish. `gms push` is that decision.
	const published: string[] = [];
	const unpublished: string[] = [];
	for (const b of pending.changed) (git.remoteRefExists(b) ? published : unpublished).push(b);

	if (published.length > 0) {
		console.log("");
		if (pending.push) {
			console.log(`pushing ${published.join(", ")}`);
			pushBranches(git, published, "fix the cause and re-run `gms merge`");
		} else {
			console.log(`${published.length} branch(es) updated locally. push them with:`);
			console.log(`  ${style(`git -C ${git.root} ${pushArgsFor(published).join(" ")}`, "bold")}`);
		}
	}

	if (unpublished.length > 0) {
		console.log("");
		console.log(`not pushed — no remote branch yet: ${unpublished.join(", ")}`);
		console.log(`  ${style("gms push", "bold")} — publish them when you are ready to open PRs`);
	}
}

import { openRepo } from "../context.ts";
import { fail } from "../errors.ts";
import { style } from "../render.ts";
import { stackForBranch } from "../state.ts";

/**
 * The trunk is repo-wide, so moving it re-bases every stack at once. That is a real thing
 * to want when a repo renames its default branch, but far too blunt to leave on `gms init`.
 */
export function trunk(args: { branch?: string }): void {
	const ctx = openRepo();
	const { git, state } = ctx;

	if (!args.branch) {
		console.log(`trunk: ${style(state.trunk, "cyan")}`);
		const n = state.stacks.length;
		console.log(`  ${style(`${n} ${n === 1 ? "stack" : "stacks"} in ${state.repo} on it`, "dim")}`);
		return;
	}

	const next = args.branch;
	if (!git.branchExists(next) && !git.remoteRefExists(next)) {
		fail(`no branch or origin ref named '${next}'`);
	}

	const owner = stackForBranch(state, next);
	if (owner) {
		fail(
			`'${next}' is tracked in stack '${owner.name}'`,
			"the trunk is never a stack member",
			`gms untrack ${next} — if it really is the trunk`,
		);
	}

	if (next === state.trunk) {
		console.log(`trunk is already ${style(next, "cyan")}`);
		return;
	}

	// Narrate before writing: this silently re-parents the bottom of every stack.
	console.log(`trunk ${style(state.trunk, "cyan")} -> ${style(next, "cyan")}`);
	for (const s of state.stacks) {
		const bottom = s.branches[0];
		console.log(
			bottom
				? `  ${style(s.name, "bold")}: ${style(bottom.name, "bold")} now sits on ${style(next, "cyan")}`
				: `  ${style(s.name, "bold")}: ${style("empty", "dim")}`,
		);
	}

	state.trunk = next;
	ctx.save();
	console.log(`  ${style("no branches were changed", "dim")}`);
}

import { openRepo } from "../context.ts";
import { fail } from "../errors.ts";
import { style } from "../render.ts";
import { resolveStack, stackForBranch } from "../state.ts";

/** Adopt an existing branch into a stack — the escape hatch for chains built by hand. */
export function track(args: { branch?: string; stack?: string; after?: string }): void {
	const ctx = openRepo();
	const { git, state } = ctx;
	const current = git.currentBranch();
	const branch = args.branch ?? current;

	if (!git.branchExists(branch)) fail(`no local branch named '${branch}'`);
	if (branch === state.trunk) fail(`'${branch}' is the trunk; it is never a stack member`);

	const owner = stackForBranch(state, branch);
	if (owner) fail(`'${branch}' is already tracked in stack '${owner.name}'`);

	const stack = resolveStack(state, args.stack, args.branch ? state.trunk : current);

	let index = stack.branches.length;
	if (args.after) {
		const i = stack.branches.findIndex((b) => b.name === args.after);
		if (i === -1) fail(`'${args.after}' is not in stack '${stack.name}'`);
		index = i + 1;
	}

	stack.branches.splice(index, 0, { name: branch });
	ctx.save();

	const parent = index === 0 ? state.trunk : (stack.branches[index - 1]?.name ?? state.trunk);
	console.log(`tracked ${style(branch, "bold")} in stack ${stack.name}, above ${style(parent, "cyan")}`);
}

/** Removes state only — never deletes the branch. Prints the command instead. */
export function untrack(args: { branch?: string }): void {
	const ctx = openRepo();
	const { git, state } = ctx;
	const branch = args.branch ?? git.currentBranch();

	const stack = stackForBranch(state, branch);
	if (!stack) fail(`'${branch}' is not tracked in any stack`);

	const i = stack.branches.findIndex((b) => b.name === branch);
	stack.branches.splice(i, 1);
	ctx.save();

	console.log(`untracked ${style(branch, "bold")} from stack ${stack.name}`);
	if (git.branchExists(branch)) {
		console.log(`  the branch still exists; delete it yourself if you want to:`);
		console.log(`    ${style(`git -C ${git.root} branch -d ${branch}`, "dim")}`);
	}
}

export function stacks(): void {
	const { state } = openRepo();
	if (state.stacks.length === 0) {
		console.log(`no stacks tracked for ${state.repo}`);
		return;
	}
	for (const s of state.stacks) {
		const names = s.branches.map((b) => b.name).join(" -> ");
		console.log(`${style(s.name, "bold")}  (${state.trunk})  ${names || style("empty", "dim")}`);
	}
}

export function removeStack(args: { name: string }): void {
	const ctx = openRepo();
	const i = ctx.state.stacks.findIndex((s) => s.name === args.name);
	if (i === -1) fail(`no stack named '${args.name}'`);
	const [removed] = ctx.state.stacks.splice(i, 1);
	ctx.save();
	console.log(
		`dropped stack ${style(args.name, "bold")} (${removed?.branches.length ?? 0} branches untracked)`,
	);
	console.log(`  ${style("no branches were deleted", "dim")}`);
}

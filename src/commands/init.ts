import { detectTrunk, openRepo } from "../context.ts";
import { fail } from "../errors.ts";
import { style } from "../render.ts";
import { stackForBranch } from "../state.ts";

export function init(args: { name?: string; trunk?: string }): void {
	const ctx = openRepo();
	const { git, state } = ctx;
	const current = git.currentBranch();

	if (args.trunk) {
		if (!git.branchExists(args.trunk) && !git.remoteRefExists(args.trunk)) {
			fail(`no branch or origin ref named '${args.trunk}'`);
		}
		state.trunk = args.trunk;
	} else if (state.stacks.length === 0) {
		state.trunk = detectTrunk(git, ctx.config);
	}

	const onTrunk = current === state.trunk;
	const name = args.name ?? (onTrunk ? undefined : current);
	if (!name) fail("a stack name is required when you are on the trunk", "gms init <name>");

	if (state.stacks.some((s) => s.name === name)) fail(`stack '${name}' already exists`);

	const existing = onTrunk ? null : stackForBranch(state, current);
	if (existing) {
		fail(
			`'${current}' is already tracked in stack '${existing.name}'`,
			"gms untrack it first, or start the new stack from the trunk",
		);
	}

	state.stacks.push({
		name,
		createdAt: new Date().toISOString(),
		branches: onTrunk ? [] : [{ name: current }],
	});
	ctx.save();

	console.log(`created stack ${style(name, "bold")} on trunk ${style(state.trunk, "cyan")}`);
	if (!onTrunk) console.log(`  seeded with the current branch ${style(current, "bold")}`);
	else console.log(`  ${style("gms add <branch>", "dim")} to put the first branch on it`);
}

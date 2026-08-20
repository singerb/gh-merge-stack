import { openRepo } from "../context.ts";
import { fail } from "../errors.ts";
import { style } from "../render.ts";
import { findStack, type RepoState, type Stack, stackForBranch } from "../state.ts";

/**
 * `add` may only build on a stack's tip, so the current branch alone identifies the stack:
 * candidates are exactly those whose tip is where you are standing. An empty stack's tip is
 * the trunk, which is what makes `gms init foo && gms add bar` work without `--stack`.
 */
function resolveByTip(state: RepoState, explicit: string | undefined, current: string): Stack {
	if (explicit) return findStack(state, explicit);

	const tipOf = (s: Stack) => s.branches.at(-1)?.name ?? state.trunk;
	const candidates = state.stacks.filter((s) => tipOf(s) === current);

	if (candidates.length === 1 && candidates[0]) return candidates[0];
	if (candidates.length > 1) {
		fail(
			`several stacks have '${current}' as their tip`,
			`pass --stack <name>: ${candidates.map((s) => s.name).join(", ")}`,
		);
	}

	const owner = stackForBranch(state, current);
	if (owner) {
		fail(
			`gms add builds on the tip of '${owner.name}', which is '${tipOf(owner)}' — you are on '${current}'`,
			"gms top — move to the tip first",
		);
	}
	if (state.stacks.length === 0) fail(`no stacks tracked for ${state.repo}`, "gms init <name> — start one");
	fail(
		`'${current}' is not the tip of any stack`,
		`known stacks: ${state.stacks.map((s) => `${s.name} (tip ${tipOf(s)})`).join(", ")}`,
	);
}

/** Create `branch` off the stack tip, append it, and check it out. */
export function add(args: { branch: string; stack?: string }): void {
	const ctx = openRepo();
	const { git, state } = ctx;
	const current = git.currentBranch();
	const stack = resolveByTip(state, args.stack, current);

	if (git.branchExists(args.branch)) {
		fail(
			`branch '${args.branch}' already exists`,
			`gms track ${args.branch} — adopt it into a stack instead`,
		);
	}
	const owner = stackForBranch(state, args.branch);
	if (owner) fail(`'${args.branch}' is already tracked in stack '${owner.name}'`);

	const tip = stack.branches.at(-1)?.name ?? state.trunk;
	if (current !== tip) {
		fail(
			`gms add builds on the tip of '${stack.name}', which is '${tip}' — you are on '${current}'`,
			"gms top — move to the tip first",
		);
	}
	if (git.isDirty()) fail("working tree is dirty", "commit or stash before creating a branch");

	git.must(["switch", "-c", args.branch]);
	stack.branches.push({ name: args.branch });
	ctx.save();

	console.log(`created ${style(args.branch, "bold")} on top of ${style(tip, "cyan")} in stack ${stack.name}`);
}

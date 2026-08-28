import { type Ctx, openRepo } from "../context.ts";
import { fail } from "../errors.ts";
import { buildPushPlan, classifyPush, PUSHABLE, type PushState, parentOf } from "../plan.ts";
import { pushBranches } from "../push.ts";
import { style } from "../render.ts";
import { resolveStack, type Stack } from "../state.ts";

export type PushArgs = {
	stack?: string;
	to?: string;
	all?: boolean;
	dryRun?: boolean;
};

type Row = { branch: string; state: PushState; ahead: number; behind: number };

/**
 * Publishing is deliberate: `gms merge` only ever pushes branches that already exist on the
 * remote, so this is the command that creates them. Local refs only — no fetch, like `gms ls`.
 */
export function push(args: PushArgs): void {
	const ctx = openRepo();
	const { git, state } = ctx;

	if (state.pending) {
		fail(
			`a merge walk on stack '${state.pending.stack}' is unfinished`,
			"gms merge --continue — finish it before publishing",
			"gms merge --abort — back out of the in-flight merge",
		);
	}

	const current = git.currentBranch();
	const stack = resolveStack(state, args.stack, current);
	const branches = buildPushPlan({ stack, trunk: state.trunk, to: args.to, all: args.all, current });
	const rows = branches.map((branch) => facts(ctx, branch));

	preflight(ctx, rows);

	const toPush = rows.filter((r) => PUSHABLE.has(r.state));
	printPlan(rows, toPush.length, args.dryRun === true);
	if (toPush.length === 0) return;

	if (args.dryRun) {
		console.log("");
		console.log(style("dry run: nothing was pushed", "dim"));
		return;
	}

	const names = toPush.map((r) => r.branch);
	console.log("");
	pushBranches(git, names, "fix the cause and re-run `gms push`");
	suggestPrs(ctx, stack, names);
}

function facts(ctx: Ctx, branch: string): Row {
	const { git } = ctx;
	const localExists = git.branchExists(branch);
	const remoteExists = git.remoteRefExists(branch);
	const { ahead, behind } =
		localExists && remoteExists ? git.aheadBehind(branch, `origin/${branch}`) : { ahead: 0, behind: 0 };
	return { branch, ahead, behind, state: classifyPush({ localExists, remoteExists, ahead, behind }) };
}

/** A diverged branch would sink the whole atomic push, and gms never force-pushes. */
function preflight(ctx: Ctx, rows: Row[]): void {
	const diverged = rows.filter((r) => r.state === "diverged");
	if (diverged.length === 0) return;
	fail(
		`${diverged.map((r) => r.branch).join(", ")} ${diverged.length === 1 ? "has" : "have"} diverged from origin`,
		...diverged.map((r) => `${r.branch}: ↑${r.ahead} ↓${r.behind} vs origin/${r.branch}`),
		`git -C ${ctx.git.root} fetch origin — then merge the remote commits in; gms never force-pushes`,
	);
}

function describe(r: Row): string {
	switch (r.state) {
		case "new":
			return style("new", "green");
		case "ahead":
			return `↑${r.ahead}`;
		case "behind":
			return style(`↓${r.behind} behind origin — nothing to push`, "yellow");
		case "missing":
			return style("no local branch", "yellow");
		case "diverged":
			return style(`↑${r.ahead} ↓${r.behind} diverged`, "red");
		default:
			return style("up to date", "dim");
	}
}

function printPlan(rows: Row[], count: number, dryRun: boolean): void {
	const verb = dryRun ? "would push" : "pushing";
	console.log(count === 0 ? "nothing to push" : `${verb} ${count} branch(es) to origin:`);
	const width = Math.max(...rows.map((r) => r.branch.length));
	for (const r of rows) console.log(`  ${r.branch.padEnd(width)}  ${describe(r)}`);
}

/** Report-only, like sync's base fixes: gms reads PRs, it never creates them. */
function suggestPrs(ctx: Ctx, stack: Stack, pushed: string[]): void {
	const { state } = ctx;
	const missing = stack.branches.filter((b) => pushed.includes(b.name) && b.pr === undefined);
	if (missing.length === 0) return;

	console.log("");
	console.log("no pr tracked for these yet. gms does not create PRs — run these if you want them:");
	for (const b of missing) {
		const base = parentOf(stack, state.trunk, b.name) ?? state.trunk;
		console.log(`  ${style(`gh pr create --repo ${state.repo} --base ${base} --head ${b.name}`, "bold")}`);
	}
	console.log(`  ${style("gms sync — pick the pr numbers up afterwards", "dim")}`);
}

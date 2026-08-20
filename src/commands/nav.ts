import { execFileSync } from "node:child_process";
import { openRepo } from "../context.ts";
import { fail } from "../errors.ts";
import { chainOf } from "../plan.ts";
import { style } from "../render.ts";
import { resolveStack } from "../state.ts";

export type NavWhere = "up" | "down" | "top" | "bottom";

function switchTo(target: string, root: string): void {
	execFileSync("git", ["-C", root, "switch", target], { stdio: "inherit" });
}

export function nav(where: NavWhere, args: { stack?: string }): void {
	const { git, state } = openRepo();
	const current = git.currentBranch();
	const stack = resolveStack(state, args.stack, current);
	const chain = chainOf(stack, state.trunk);
	const i = chain.indexOf(current);

	if (i === -1) fail(`'${current}' is not in stack '${stack.name}'`, `stack runs: ${chain.join(" -> ")}`);

	const target =
		where === "top"
			? chain.at(-1)
			: where === "bottom"
				? chain[0]
				: where === "up"
					? chain[i + 1]
					: chain[i - 1];

	if (!target) fail(`already at the ${where === "up" ? "top" : "bottom"} of stack '${stack.name}'`);
	if (target === current) {
		console.log(`already on ${style(current, "bold")}`);
		return;
	}
	switchTo(target, git.root);
}

/** `gms co <branch|#pr>` — check out by branch name or by PR number. */
export function checkout(args: { target: string; stack?: string }): void {
	const { git, state } = openRepo();
	const wanted = args.target.replace(/^#/, "");
	const asNumber = Number(wanted);

	if (Number.isInteger(asNumber) && String(asNumber) === wanted) {
		for (const s of state.stacks) {
			const hit = s.branches.find((b) => b.pr === asNumber);
			if (hit) {
				switchTo(hit.name, git.root);
				return;
			}
		}
		fail(`no tracked branch has PR #${wanted}`, "gms sync — refresh PR associations");
	}

	if (!git.branchExists(wanted)) fail(`no local branch named '${wanted}'`);
	switchTo(wanted, git.root);
}

import { execFileSync } from "node:child_process";
import { openRepo } from "../context.ts";
import { fail } from "../errors.ts";
import { changesetArgs } from "../plan.ts";
import { style } from "../render.ts";
import { resolveStack } from "../state.ts";

/**
 * `gms changeset` — run `pnpm changeset` with the branch below this one as `--since`, so the
 * prompt only offers the commits this branch actually adds.
 */
export function changeset(args: { stack?: string; dryRun?: boolean }): void {
	const { git, state } = openRepo();
	const current = git.currentBranch();
	const stack = resolveStack(state, args.stack, current);
	const argv = changesetArgs({ stack, trunk: state.trunk, branch: current });

	console.log(`${style(`pnpm ${argv.join(" ")}`, "bold")}`);
	if (args.dryRun) {
		console.log(`  ${style("dry run — nothing was run", "dim")}`);
		return;
	}

	try {
		execFileSync("pnpm", argv, { cwd: git.root, stdio: "inherit" });
	} catch (err) {
		const e = err as { status?: number; code?: string };
		if (e.code === "ENOENT") fail("pnpm not found on PATH");
		process.exit(e.status ?? 1);
	}
}

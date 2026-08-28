import { execFileSync } from "node:child_process";
import { GmsError } from "./errors.ts";
import type { Git } from "./git.ts";

/** The only push gms ever performs: one atomic refspec set, upstream tracking, never forced. */
export function pushArgsFor(branches: string[]): string[] {
	return ["push", "--atomic", "--set-upstream", "origin", ...branches];
}

/**
 * Runs with git's output inherited rather than through `Git.run`: the progress lines and the
 * "Create a pull request" URLs github prints on a first push are for the user, not for us.
 */
export function pushBranches(git: Git, branches: string[], retryHint: string): void {
	try {
		execFileSync("git", ["-C", git.root, ...pushArgsFor(branches)], { stdio: "inherit" });
	} catch {
		throw new GmsError("push failed", `--atomic means nothing was pushed; ${retryHint}`);
	}
}

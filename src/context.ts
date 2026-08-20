import { fail } from "./errors.ts";
import { createGit, type Git } from "./git.ts";
import { type Config, loadConfig, loadState, type RepoState, repoSlug, saveState } from "./state.ts";

export type Ctx = {
	git: Git;
	slug: string;
	config: Config;
	state: RepoState;
	save(): void;
};

/** origin/HEAD, else configured default, else whichever of main/master exists. */
export function detectTrunk(git: Git, config: Config): string {
	const head = git.run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (head.ok && head.stdout.startsWith("origin/")) return head.stdout.slice("origin/".length);
	if (config.defaultTrunk) return config.defaultTrunk;
	for (const candidate of ["main", "master"]) {
		if (git.branchExists(candidate) || git.remoteRefExists(candidate)) return candidate;
	}
	fail(
		"could not determine the trunk branch",
		"set it with `gms init --trunk <branch>`, or `git remote set-head origin --auto`",
	);
}

export function openRepo(): Ctx {
	const git = createGit();
	const config = loadConfig();
	const slug = repoSlug(git, config.remote ?? "origin");
	const state = loadState(slug, detectTrunk(git, config));
	return { git, slug, config, state, save: () => saveState(state) };
}

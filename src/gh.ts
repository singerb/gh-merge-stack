import { execFileSync } from "node:child_process";
import { fail } from "./errors.ts";
import type { PrState } from "./state.ts";

export type PrInfo = {
	number: number;
	state: PrState;
	headRefName: string;
	baseRefName: string;
	url: string;
	title: string;
};

const FIELDS = "number,state,headRefName,baseRefName,url,title";

/** Preference order when one branch has several PRs: an open one wins, then the most recent. */
const RANK: Record<PrState, number> = { OPEN: 3, MERGED: 2, CLOSED: 1 };

export function indexByHead(prs: PrInfo[]): Map<string, PrInfo> {
	const byHead = new Map<string, PrInfo>();
	for (const pr of prs) {
		const existing = byHead.get(pr.headRefName);
		if (!existing) {
			byHead.set(pr.headRefName, pr);
			continue;
		}
		const better =
			RANK[pr.state] > RANK[existing.state] ||
			(RANK[pr.state] === RANK[existing.state] && pr.number > existing.number);
		if (better) byHead.set(pr.headRefName, pr);
	}
	return byHead;
}

/** One `gh pr list` for the whole repo, indexed by head branch — never N calls. */
export function listPrs(slug: string, limit = 200): Map<string, PrInfo> {
	let out: string;
	try {
		out = execFileSync(
			"gh",
			["pr", "list", "--repo", slug, "--state", "all", "--limit", String(limit), "--json", FIELDS],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
		);
	} catch (err) {
		const e = err as { stderr?: string; code?: string };
		if (e.code === "ENOENT") fail("gh not found on PATH", "https://cli.github.com");
		fail(`gh pr list failed for ${slug}`, (e.stderr ?? "").trim() || "(no stderr)");
	}
	try {
		return indexByHead(JSON.parse(out) as PrInfo[]);
	} catch (err) {
		fail("could not parse gh pr list output", String(err));
	}
}

import { openRepo } from "../context.ts";
import { fail } from "../errors.ts";
import { chainOf } from "../plan.ts";
import { type Cell, cell, pad, prCell, renderStackMarkdown, stateCell, style, widestOf } from "../render.ts";
import { type RepoState, resolveStack, type Stack } from "../state.ts";

type Row = {
	current: boolean;
	name: Cell;
	pr: Cell;
	state: Cell;
	vs: string;
	notes: string[];
	url?: string;
};

export type LsArgs = {
	stack?: string;
	json?: boolean;
	urls?: boolean;
	markdown?: boolean;
	forBranch?: string;
	forCurrent?: boolean;
};

/** Local-only: reads git refs and the state file, never the network, so it stays instant. */
export function ls(args: LsArgs): void {
	const { git, state } = openRepo();
	const current = git.currentBranch();

	if (args.markdown) {
		printMarkdown(state, current, args);
		return;
	}
	if (args.forBranch !== undefined || args.forCurrent) {
		fail("--for and --for-current only mean anything with --markdown", "gms ls --markdown --for-current");
	}

	const wanted = args.stack ? state.stacks.filter((s) => s.name === args.stack) : state.stacks;

	if (args.json) {
		const payload = { repo: state.repo, trunk: state.trunk, current, stacks: wanted, pending: state.pending };
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	// An interrupted walk is easy to forget about; say so before anything else.
	if (state.pending) {
		const { stack, doneCount, pairs } = state.pending;
		const at = pairs[doneCount];
		console.log(
			style(`unfinished merge walk on stack '${stack}'`, "yellow") +
				(at ? ` — stopped merging ${at.parent} into ${at.child}` : " — ready to finish"),
		);
		console.log(`  ${style("gms merge --continue", "bold")} or ${style("gms merge --abort", "bold")}`);
		console.log("");
	}

	if (wanted.length === 0) {
		console.log(`no stacks tracked for ${state.repo}`);
		console.log(`  ${style("gms init <name>", "dim")} to start one`);
		return;
	}

	for (const [i, stack] of wanted.entries()) {
		if (i > 0) console.log("");
		printStack(stack, state.trunk, current, git, args.urls === true);
	}
}

/**
 * Markdown targets one PR body, so it resolves a single stack rather than printing them all, and
 * emits nothing but the block itself — no pending-walk banner, no advice.
 */
function printMarkdown(state: RepoState, current: string, args: LsArgs): void {
	if (args.json) fail("--json and --markdown are different formats", "pick one");
	if (args.forBranch !== undefined && args.forCurrent) {
		fail("--for and --for-current cannot both be given");
	}

	const stack = resolveStack(state, args.stack, current);
	const inStack = (name: string) => stack.branches.some((b) => b.name === name);
	let highlight: string | undefined;

	if (args.forCurrent) {
		if (!inStack(current)) {
			fail(
				`'${current}' is not in stack '${stack.name}'`,
				"gms ls --markdown --for <branch> — mark a specific one instead",
			);
		}
		highlight = current;
	} else if (args.forBranch !== undefined) {
		if (!inStack(args.forBranch)) fail(`'${args.forBranch}' is not in stack '${stack.name}'`);
		highlight = args.forBranch;
	}

	console.log(renderStackMarkdown({ branches: stack.branches, trunk: state.trunk, highlight }));
}

function printStack(
	stack: Stack,
	trunk: string,
	current: string,
	git: ReturnType<typeof openRepo>["git"],
	showUrls: boolean,
): void {
	console.log(`${style(stack.name, "bold")}  (${style(trunk, "cyan")})`);
	if (stack.branches.length === 0) {
		console.log(`  ${style("empty", "dim")}`);
		return;
	}

	const chain = chainOf(stack, trunk);
	const rows: Row[] = stack.branches.map((b, i) => {
		const parent = chain[i] as string;
		const notes: string[] = [];
		let vs = "";

		if (!git.branchExists(b.name)) {
			notes.push(style("no local branch", "yellow"));
		} else {
			// Compare against the remote trunk so `↓` reflects what a fetch would bring up.
			const parentRef = parent === trunk && git.remoteRefExists(trunk) ? `origin/${trunk}` : parent;
			if (git.revParse(parentRef)) {
				const { ahead, behind } = git.aheadBehind(b.name, parentRef);
				const behindText = behind > 0 ? style(`↓${behind}`, "yellow") : "↓0";
				vs = `↑${ahead} ${behindText} vs ${parent}`;
			}
			if (git.remoteRefExists(b.name)) {
				const { ahead } = git.aheadBehind(b.name, `origin/${b.name}`);
				if (ahead > 0) notes.push(`↑${ahead} unpushed`);
			} else if (git.hasUpstreamConfig(b.name)) {
				notes.push(style("remote branch gone", "yellow"));
			} else {
				notes.push(style("never pushed", "dim"));
			}
		}

		return {
			current: b.name === current,
			name: cell(b.name, b.name === current ? style(b.name, "bold") : b.name),
			pr: prCell(b.pr, b.prUrl),
			state: stateCell(b.prState),
			vs,
			notes,
			url: b.prUrl,
		};
	});

	const nameWidth = widestOf(rows.map((r) => r.name));
	const prWidth = widestOf(rows.map((r) => r.pr));
	const stateWidth = widestOf(rows.map((r) => r.state));
	const vsWidth = Math.max(...rows.map((r) => r.vs.length));

	for (const r of rows) {
		const marker = r.current ? style(">", "green") : " ";
		const parts = [
			`${marker} ${pad(r.name, nameWidth)}`,
			pad(r.pr, prWidth),
			pad(r.state, stateWidth),
			r.vs.padEnd(r.notes.length > 0 ? vsWidth : 0),
			r.notes.join("  "),
		];
		console.log(`  ${parts.join("  ").trimEnd()}`);
		if (showUrls && r.url) console.log(`      ${style(r.url, "dim")}`);
	}
}

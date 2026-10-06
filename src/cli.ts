import { parseArgs } from "node:util";
import { add } from "./commands/add.ts";
import { changeset } from "./commands/changeset.ts";
import { init } from "./commands/init.ts";
import { ls } from "./commands/ls.ts";
import { merge } from "./commands/merge.ts";
import { checkout, nav } from "./commands/nav.ts";
import { push } from "./commands/push.ts";
import { sync } from "./commands/sync.ts";
import { removeStack, stacks, track, untrack } from "./commands/track.ts";
import { trunk } from "./commands/trunk.ts";
import { GmsError } from "./errors.ts";
import { style } from "./render.ts";

const USAGE = `gms — stacks of branches that update by merging, never rebasing

usage: gms <command> [options]

  ls [--stack <n>] [--urls] [--json]   show the stack (default command)
     [--markdown]                      markdown for a pr description
     [--for <b> | --for-current]       mark one entry as "this PR"
  stacks                               list every tracked stack in this repo
  init [name] [--trunk <b>]            start a stack, seeded with the current branch
  add <branch>                         create <branch> on the stack tip and check it out
  track [branch] [--after <b>]         adopt an existing branch into a stack
  untrack [branch]                     stop tracking a branch (never deletes it)
  rm <stack>                           drop a whole stack's tracking
  trunk [<branch>]                     show the trunk, or move every stack onto <branch>

  merge [--from <b>] [--to <b>]        merge up the stack, one branch at a time
        [-n] [--no-push]               defaults: --from trunk, --to the current branch
        [--continue] [--abort]         only pushes branches already on the remote
                                       <b> may also be prev, next, -N or +N,
                                       counted from the current branch

  push [--to <b>] [--all] [-n]         publish the stack; creates remote branches
                                       default: bottom -> the current branch

  sync [--prune] [-n]                  reconcile with the remote after PRs land
  changeset [-n]                       pnpm changeset, --since the branch below this one
  up | down | top | bottom             move along the stack
  co <branch|#pr>                      check out by branch name or PR number

common options: --stack <name>, -n/--dry-run, -h/--help`;

const OPTIONS = {
	stack: { type: "string" },
	trunk: { type: "string" },
	from: { type: "string" },
	to: { type: "string" },
	after: { type: "string" },
	for: { type: "string" },
	"for-current": { type: "boolean" },
	all: { type: "boolean" },
	"dry-run": { type: "boolean" },
	n: { type: "boolean" },
	"no-push": { type: "boolean" },
	markdown: { type: "boolean" },
	continue: { type: "boolean" },
	abort: { type: "boolean" },
	prune: { type: "boolean" },
	"keep-empty": { type: "boolean" },
	urls: { type: "boolean" },
	json: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

/** parseArgs refuses `--from -1` as ambiguous; glue relative refs on so it reads `--from=-1`. */
function joinNegativeRefs(argv: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		const next = argv[i + 1];
		if ((a === "--from" || a === "--to") && next !== undefined && /^-\d+$/.test(next)) {
			out.push(`${a}=${next}`);
			i++;
		} else {
			out.push(a);
		}
	}
	return out;
}

function main(argv: string[]): void {
	const { values, positionals } = parseArgs({
		args: joinNegativeRefs(argv),
		options: OPTIONS,
		allowPositionals: true,
	});

	const command = positionals[0] ?? "ls";
	if (values.help) {
		console.log(USAGE);
		return;
	}

	const dryRun = values["dry-run"] === true || values.n === true;
	const arg = (i: number) => positionals[i];
	const require1 = (what: string): string => {
		const v = arg(1);
		if (!v) throw new GmsError(`${command} needs a ${what}`, `gms ${command} <${what}>`);
		return v;
	};

	switch (command) {
		case "ls":
		case "status":
			ls({
				stack: values.stack,
				json: values.json,
				urls: values.urls,
				markdown: values.markdown,
				forBranch: values.for,
				forCurrent: values["for-current"],
			});
			return;
		case "stacks":
			stacks();
			return;
		case "init":
			init({ name: arg(1), trunk: values.trunk });
			return;
		case "add":
			add({ branch: require1("branch"), stack: values.stack });
			return;
		case "track":
			track({ branch: arg(1), stack: values.stack, after: values.after });
			return;
		case "untrack":
			untrack({ branch: arg(1) });
			return;
		case "rm":
			removeStack({ name: require1("stack name") });
			return;
		case "trunk":
			trunk({ branch: arg(1) });
			return;
		case "merge":
			merge({
				from: values.from,
				to: values.to,
				stack: values.stack,
				dryRun,
				noPush: values["no-push"],
				continue: values.continue,
				abort: values.abort,
			});
			return;
		case "changeset":
			changeset({ stack: values.stack, dryRun });
			return;
		case "push":
			push({ stack: values.stack, to: values.to, all: values.all, dryRun });
			return;
		case "sync":
		case "resync":
			sync({
				stack: values.stack,
				dryRun,
				prune: values.prune,
				keepEmpty: values["keep-empty"],
			});
			return;
		case "up":
		case "down":
		case "top":
		case "bottom":
			nav(command, { stack: values.stack });
			return;
		case "co":
		case "checkout":
			checkout({ target: require1("branch or #pr"), stack: values.stack });
			return;
		case "help":
			console.log(USAGE);
			return;
		default:
			throw new GmsError(`unknown command '${command}'`, "gms --help");
	}
}

try {
	main(process.argv.slice(2));
} catch (err) {
	if (err instanceof GmsError) {
		console.error(`${style("error:", "red")} ${err.message}`);
		for (const hint of err.hints) console.error(`  ${style(hint, "dim")}`);
		process.exit(1);
	}
	if (err instanceof Error && err.message.includes("Unknown option")) {
		console.error(`${style("error:", "red")} ${err.message}`);
		console.error(`  ${style("gms --help", "dim")}`);
		process.exit(1);
	}
	throw err;
}

# gms — merge-based branch stacks

A stack is a chain of branches, each opening an ordinary PR against the one below it.
`gms` keeps that chain up to date by **merging** — never rebasing.

```
main
 └── auth-models    PR #123 (base: main)
      └── auth-api  PR #124 (base: auth-models)
           └── auth-ui   PR #125 (base: auth-api)
```

`gh stack` rebases the whole stack whenever trunk moves, which force-pushes every branch,
churns SHAs, orphans review comments and defeats automerge. `gms` does the opposite:
branches are append-only, so a plain `git push` opens a plain PR, automerge works, and review
threads stay anchored. It is a timesaver for "take this change all the way up the stack" —
every step it takes is one you could equally do by hand in the GitHub UI.

Note: this is a personal utility, highly specific to my use case, and fully AI-authored. I'm publishing
it partly to back it up, partly to share it, but with no expectation anyone else will find
it useful. Use at your own risk (though it is careful, by design, to avoid destructive operations).

## Install

Needs node ≥ 22.18 (for native TypeScript type stripping), `git`, and `gh`.

```sh
ln -s "$PWD/bin/gms" ~/.local/bin/gms
```

No build step and no runtime dependencies — `bin/gms` execs `node src/cli.ts` directly.
The `node_modules` here is dev-only: TypeScript for typechecking and Biome for lint/format.

## Everyday use

```sh
gms init auth-refactor      # start a stack on the current trunk
gms add auth-models         # branch off the tip and check it out
git commit ...              # ordinary git from here on
gms add auth-api            # next layer, still entirely local
gms push                    # publish the stack; open the PRs however you like
```

Nothing reaches the remote until you say `gms push`, so you can build the whole stack — and merge
trunk up through it — before anyone sees it.

Set each PR's base to the branch below it so reviewers see only that layer's diff. `gms` never
creates or edits PRs — it reads them, and prints the command when something needs fixing.

### The trunk is repo-wide

Every stack in a repo sits on one trunk — there is no per-stack base, so a stack cannot be
based on another stack's branch. `gms init --trunk <b>` therefore only sets the trunk while
the repo has no stacks yet; after that it refuses, because moving the trunk moves *every*
stack at once. When you really do mean that (a repo renaming `master` to `main`, say):

```sh
gms trunk                   # what the trunk is, and how many stacks sit on it
gms trunk main              # move every stack, naming each one as it goes
```

A branch that is tracked in a stack can never be the trunk. If state ever ends up violating
that — a hand-edit, or an older gms — every command warns on stderr until `gms trunk` fixes it.

### Bringing changes up the stack

```sh
gms merge                          # trunk -> ... -> the branch you are on
gms merge --to auth-ui             # trunk all the way to the top
gms merge --from auth-models --to auth-ui   # ignore trunk, walk a slice
gms merge -n                       # print the plan, change nothing
```

The walk fetches `origin/<trunk>` itself, so you never need a local `git pull` first. It
preflights everything (clean tree, no merge in progress, every branch present, nothing checked
out in another worktree) before touching anything, then merges pair by pair and finishes with a
single `git push --atomic` covering exactly the branches whose SHA changed **and that already
exist on the remote**. A branch you have never pushed stays local, and one whose remote branch was
deleted is never resurrected; both are named at the end so you can `gms push` when you mean to.

On a conflict it stops, records where it was, and leaves you on the conflicted branch with
nothing pushed:

```sh
# resolve, then:
git add . && git commit
gms merge --continue     # or: gms merge --abort
```

### Publishing

```sh
gms push            # bottom of the stack -> the branch you are on
gms push --all      # the whole stack
gms push -n         # preview
```

One `git push --atomic --set-upstream`, creating remote branches that do not exist yet. Branches
already up to date are skipped, and a branch that has diverged from its remote refuses the whole
command rather than forcing anything. For freshly published branches with no PR yet it prints the
`gh pr create --base <the branch below>` line — gms never runs it for you.

### After PRs land

```sh
gms sync            # reconcile with the remote
gms sync -n         # preview
gms sync --prune    # also clean up (see below)
```

`sync` fetches with `--prune`, reads every PR in one `gh pr list`, then classifies each tracked
branch:

| classification | meaning | what `sync` does |
| --- | --- | --- |
| `merged` | PR merged, or an ancestor of `origin/<trunk>` | untrack, re-link its child, suggest `git branch -d` |
| `merged, remote deleted` | landed and GitHub deleted the head branch | same |
| `abandoned` | remote branch deleted but *not* merged | report only — never touched, even under `--prune` |
| `new` | never pushed | left alone |
| `gone` | no local branch (deleted in another worktree) | untrack, but only under `--prune` |
| `no pr yet` | pushed, no PR | clear the cached PR fields |

`--prune` is the single deliberate exception to the never-destroy rule: it untracks `gone`
branches and runs `git branch -d` (safe delete only — `-D` is unreachable from anywhere in
gms) on branches that have actually landed. `abandoned` branches are the case where a commit
could exist nowhere else, so they are always left alone.

### Writing a changeset

```sh
gms changeset       # pnpm changeset, scoped to this branch's own commits
gms changeset -n    # print the command, run nothing
```

A changeset should describe what *this* branch adds, not everything beneath it. On the bottom
branch that is what `pnpm changeset` already does; higher up, gms supplies the branch below as
`--since`, so you never have to look the name up:

```
auth-models   ->  pnpm changeset
auth-api      ->  pnpm changeset --since auth-models
auth-ui       ->  pnpm changeset --since auth-api
```

### Looking around

```sh
gms ls              # the stack, with PR numbers as clickable links
gms ls --urls       # print the PR urls in full
gms ls --json       # for scripting; includes any interrupted merge walk
gms ls --markdown   # a stack list to paste into a PR description
gms up / down / top / bottom
gms co auth-api     # or: gms co '#124'
```

PR numbers in `gms ls` are OSC 8 hyperlinks, so ⌘-click opens them. Piped output stays plain;
`GMS_NO_HYPERLINKS=1` disables them.

`--markdown` renders one stack as a numbered list, bottom to top, using the PR titles and urls
`gms sync` cached:

```markdown
**Stack** (bottom → top, base `main`):

1. [#123 Extract auth models](https://github.com/o/r/pull/123)
2. [#124 Auth API endpoints](https://github.com/o/r/pull/124)
3. *(next layer — no PR yet)*
```

Nothing is marked by default, so the same block pastes into every PR in the stack. Add
`--for-current` to point at the branch you are on, or `--for <branch>` to point at another.

Branch names never appear: issue trackers that scan PR bodies for them (Shortcut, Jira) would
otherwise link every story in the stack to every PR. A PR whose title is not cached yet renders as
a bare `#123` — run `gms sync` to fill the titles in.

## State

- `~/.config/gms/config.json` — optional (`defaultTrunk`, `remote`).
- `~/.local/share/gms/stacks/<owner>__<repo>.json` — one file per repo.

`$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` are honored. State is keyed by the origin remote's
`owner/repo`, not by path, so every worktree of a repo shares one set of stacks and moving a
clone does not orphan them. Files are written atomically and pretty-printed — editing one by
hand is a supported way out of a mess.

## Agent skill

`skills/gms/SKILL.md` is a vendor-neutral skill file: the model, the command surface, the
workflows, and the rules an agent would otherwise get wrong (left to itself it reaches for
`git rebase` and `gh pr edit`, because every other stacking tool works that way).

For an agent with a skills directory, symlink the folder — personally, or into the repo where you
actually stack branches:

```sh
ln -s "$PWD/skills/gms" ~/.claude/skills/gms                # personal
ln -s "$PWD/skills/gms" /path/to/repo/.claude/skills/gms    # one repo
```

Copy the folder instead if your agent does not follow symlinks.

For anything else, point it at the file — a line in the repo's `AGENTS.md` is enough:

```markdown
For stacked branches, follow ~/src/gh-merge-stack/skills/gms/SKILL.md.
```

## Design rules

- **Never destroy silently.** No `push --force`, no `reset --hard`, no `git branch -D`, ever.
  When the right move is destructive, gms prints the command for you to run. The one exception
  is `gms sync --prune`, which is opt-in per invocation and narrates everything it does.
- **Preflight before mutating.** A refused command has changed nothing.
- **Stacks are linear.** Branching trees are an explicit non-goal.

## Development

```sh
npm run typecheck        # tsc --noEmit
npm test                 # node --test, unit tests over the pure logic
npm run test:integration # end-to-end against a throwaway repo, fully offline
npm run check            # biome
```

`test/integration.sh` builds a real repo with a bare origin, stubs `gh` with a fixture, and
redirects the XDG dirs, so it never touches your stacks or the network.

---
name: gms
description: >-
  Manage stacks of branches that update by merging, never rebasing, with the `gms` CLI.
  Use when working with stacked branches or dependent PRs in a repo where `gms` is installed:
  starting a stack, adding a layer, carrying trunk changes up the stack, publishing branches,
  reconciling after PRs land, or navigating between stack branches.
---

# gms — merge-based branch stacks

`gms` manages a **stack**: a linear chain of branches, each opening an ordinary PR against the
one below it.

```
main (trunk)
 └── auth-models    PR #123 (base: main)      <- bottom, nearest the trunk
      └── auth-api  PR #124 (base: auth-models)
           └── auth-ui   PR #125 (base: auth-api)   <- top
```

The chain stays current by **merging** down-to-up — never rebasing. Branches are append-only, so
a plain `git push` works, automerge works, and review threads stay anchored to their commits.

Three structural facts shape everything below:

- **The trunk is repo-wide.** One trunk per repo, not per stack. A stack cannot sit on another
  stack's branch, and a tracked branch can never be the trunk.
- **Stacks are linear.** Branching trees are an explicit non-goal.
- **Nothing is inferred from git.** The chain lives in a JSON state file; branch names, git refs
  and PR metadata are never authoritative. PR fields are a cache that `gms sync` refreshes.

## Rules you must not break

These are the point of the tool. Violating one silently undoes work `gms` exists to protect.

1. **Never rebase or force-push a stack branch.** No `git rebase`, no `push --force`/
   `--force-with-lease`, no `reset --hard`, no `git branch -D`. `gms` makes these unreachable by
   design; when the right move is destructive it prints the command and lets the user run it.
   If a branch has diverged from its remote, fetch and **merge** the remote commits in.
2. **`gms` never creates or edits PRs.** It reads them. After a push it prints
   `gh pr create --repo <slug> --base <branch below> --head <branch>`; after a sync it prints
   `gh pr edit <n> --repo <slug> --base <expected>` when a base drifts. Surface those commands to
   the user. Run them only if the user asks you to.
3. **Nothing reaches the remote until `gms push`.** `gms merge` pushes only branches that
   *already* exist on the remote; it never resurrects a deleted remote branch and never publishes
   one that was never pushed. Publishing is a deliberate, separate decision.
4. **Preview before mutating when the state is unclear.** `merge`, `push`, `sync` and `changeset`
   all take `-n` / `--dry-run`. A refused command has changed nothing — `gms` preflights
   everything before it touches anything, so read the error rather than working around it.
5. **`gms sync --prune` is the one destructive path.** It untracks `gone` branches and runs
   `git branch -d` (safe delete only) on branches that actually landed. Confirm with the user
   before running it, or run `gms sync --prune -n` first. Branches classified `abandoned` are
   never touched, even under `--prune` — they may hold commits that exist nowhere else.
6. **Do not stash or commit on the user's behalf.** `gms add` and `gms merge` require a clean
   working tree. If the tree is dirty, say so and stop.
7. **Repair state by editing the state file, not by force.** Hand-editing
   `~/.local/share/gms/stacks/<owner>__<repo>.json` is a supported escape hatch. `warning:` lines
   on stderr mean the state violates an invariant and needs repair.

## Prerequisites

`node >= 22.18`, `git`, and `gh` on `PATH` and authenticated (`gh` is invoked only by `gms sync`,
for one `gh pr list`). Requires an `origin` remote and a non-detached HEAD. `gms changeset`
additionally needs `pnpm`.

## Commands

`-n` / `--dry-run`, `--stack <name>` and `-h` / `--help` are common to the commands that use them.
`--stack` disambiguates when the current branch does not identify a single stack.

| command | flags | what it does |
| --- | --- | --- |
| `ls` (default; alias `status`) | `--stack`, `--urls`, `--json`, `--markdown`, `--for <b>`, `--for-current` | Show the stack: PR number, PR state, ahead/behind vs the branch below, and notes (`never pushed`, `remote branch gone`, `no local branch`). Local only — no network. |
| `stacks` | — | One line per tracked stack in this repo: name, trunk, chain. |
| `init [name]` | `--trunk <b>` | Start a stack, seeded with the current branch (a name is required when you are on the trunk). |
| `add <branch>` | `--stack` | Create `<branch>` on the stack tip and check it out. Tip only. |
| `track [branch]` | `--stack`, `--after <b>` | Adopt an existing local branch into a stack — the escape hatch for chains built by hand. |
| `untrack [branch]` | — | Stop tracking a branch. Never deletes it; prints the `git branch -d` line. |
| `rm <stack>` | — | Drop a whole stack's tracking. No branches are deleted. |
| `trunk [<branch>]` | — | Show the trunk, or move **every** stack in the repo onto `<branch>`. |
| `merge` | `--from <b>`, `--to <b>`, `--stack`, `-n`, `--no-push`, `--continue`, `--abort` | Merge up the stack one pair at a time. Defaults: `--from` the trunk, `--to` the current branch. |
| `push` | `--to <b>`, `--all`, `--stack`, `-n` | Publish: one `git push --atomic --set-upstream`. Default bottom → the current branch; `--all` for the whole stack. |
| `sync` (alias `resync`) | `--prune`, `--keep-empty`, `--stack`, `-n` | Fetch with `--prune`, read every PR in one `gh pr list`, reconcile tracking. |
| `changeset` | `--stack`, `-n` | `pnpm changeset`, scoped to this branch's own commits. |
| `up` / `down` / `top` / `bottom` | `--stack` | Move along the stack. |
| `co <branch\|#pr>` (alias `checkout`) | `--stack` | Check out by branch name or by PR number. |

## Workflows

### Start a stack

```sh
gms init auth-refactor      # on the trunk: a name is required
gms add auth-models         # branch off the tip and check it out
git commit ...              # ordinary git from here on
gms add auth-api            # next layer, still entirely local
```

`gms add` builds only on the **tip** of a stack. If the user is mid-stack, `gms top` first. It
refuses if the branch already exists (use `gms track` instead) or if the tree is dirty.

Everything so far is local. The whole stack — including merging trunk up through it — can be
built before anyone sees it.

### Adopt a chain built by hand

```sh
gms init <name>                    # on the bottom branch: seeds the stack with it
gms track auth-api                 # append the current or named branch
gms track auth-ui --after auth-api # insert at a specific position
```

### Carry trunk (or any lower branch) up the stack

```sh
gms merge                                    # trunk -> ... -> the branch you are on
gms merge --to auth-ui                       # trunk all the way to the top
gms merge --from auth-models --to auth-ui    # ignore trunk, walk a slice
gms merge -n                                 # print the plan, change nothing
gms merge --no-push                          # merge locally, print the push command
```

The walk fetches `origin/<trunk>` itself, so a local `git pull` is never a prerequisite. It
preflights the lot — clean tree, no merge/rebase/cherry-pick in progress, every branch present,
nothing checked out in another worktree — then merges pair by pair, and finishes with a single
`git push --atomic` covering exactly the branches whose SHA changed **and that already exist on
the remote**. Branches that stayed local are named at the end for `gms push`.

`merge` only goes upward; `--to` below `--from` is an error. A pending merge walk blocks a new
`merge` and blocks `push` until it is finished or aborted.

### A conflict during the walk

`gms` stops, records where it was, leaves you on the conflicted branch, and pushes nothing.

```sh
# resolve the listed files, then:
git add <files> && git commit
gms merge --continue        # or: gms merge --abort
```

`--continue` requires the merge to be committed, the tree clean, and HEAD on the branch the walk
stopped at. `--abort` backs out of the in-flight merge only — branches merged earlier in the walk
are left as they are, and are named so the user knows.

### Publish

```sh
gms push            # bottom of the stack -> the branch you are on
gms push --all      # the whole stack
gms push -n         # preview
```

One `git push --atomic --set-upstream`, creating remote branches that do not exist yet. Branches
already up to date are skipped. A branch that has **diverged** from its remote refuses the whole
command rather than forcing anything — fetch, merge the remote commits in, and re-run.

For freshly published branches with no PR yet, `gms` prints the `gh pr create --base <branch
below>` line. Set each PR's base to the branch below it so reviewers see only that layer's diff.
Then `gms sync` to pick up the PR numbers.

### After PRs land

```sh
gms sync            # reconcile with the remote
gms sync -n         # preview
gms sync --prune    # also clean up — ask first
```

| classification | meaning | what `sync` does |
| --- | --- | --- |
| `merged` | PR merged, or an ancestor of `origin/<trunk>` | untrack, re-link its child, suggest `git branch -d` |
| `merged, remote deleted` | landed and the head branch was deleted | same |
| `abandoned` | remote branch deleted but *not* merged | report only — never touched, even under `--prune` |
| `new` | never pushed | left alone |
| `gone` | no local branch (deleted in another worktree) | untrack, but only under `--prune` |
| `no pr yet` | pushed, no PR | clear the cached PR fields |

`sync` also drops any stack it empties, unless `--keep-empty` is passed. It reports PR bases that
no longer match the stack, but never edits them — and note GitHub often retargets automatically
when a merged base branch is deleted.

### A stack list for a PR description

```sh
gms ls --markdown                  # nothing marked: the same block pastes into every PR
gms ls --markdown --for-current    # point at the branch you are on
gms ls --markdown --for auth-api   # point at another branch
```

Renders one stack bottom-to-top from the PR titles and urls `gms sync` cached. **Branch names are
deliberately omitted** — issue trackers that scan PR bodies for them would otherwise link every
story in the stack to every PR. A PR whose title is not cached yet renders as a bare `#123`; run
`gms sync` to fill titles in.

### Writing a changeset

```sh
gms changeset       # pnpm changeset, scoped to this branch's own commits
gms changeset -n    # print the command, run nothing
```

A changeset should describe what *this* branch adds, not everything beneath it. On the bottom
branch that is plain `pnpm changeset`; higher up, `gms` supplies the branch below as `--since`.

### Navigating

```sh
gms ls
gms up / down / top / bottom
gms co auth-api
gms co '#124'       # quote it, or the shell eats the #
```

`gms down` from the bottom branch checks out the **trunk** — the trunk is part of the nav chain.

## Reading state programmatically

`gms ls --json` emits `{ repo, trunk, current, stacks, pending }`, including any interrupted merge
walk. Warnings go to stderr, so the JSON stays clean and pipeable. Prefer it over parsing the
human output.

Color and OSC 8 hyperlinks are TTY-only; `NO_COLOR` or `GMS_NO_HYPERLINKS=1` disable them
explicitly.

## State on disk

- `~/.config/gms/config.json` — optional: `defaultTrunk`, `remote`.
- `~/.local/share/gms/stacks/<owner>__<repo>.json` — one file per repo.

`$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` are honored. State is keyed by the origin remote's
`owner/repo`, not by path, so every worktree of a repo shares one set of stacks and moving a clone
does not orphan them. Files are written atomically; editing one by hand is a supported way out of
a mess.

## Errors worth recognizing

| you see | it means |
| --- | --- |
| `gms add builds on the tip of 'S', which is 'T'` | move with `gms top` (or `gms track` an existing branch) |
| `working tree is dirty` | commit or stash first — the user's call, not yours |
| `a merge walk on stack 'X' is unfinished` | `gms merge --continue` or `--abort` before anything else |
| `'X' is checked out in another worktree` | that worktree must move off the branch first |
| `<branches> have diverged from origin` | fetch and merge the remote commits in; never force |
| `--trunk would move the trunk from 'X' to 'Y'` | the trunk is repo-wide — `gms trunk Y` moves every stack |
| `'X' is not in any stack and <repo> has several` | pass `--stack <name>` |
| `warning: ...` on stderr | the state file violates an invariant; `gms trunk` or a hand-edit fixes it |

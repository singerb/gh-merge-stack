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
git push -u origin HEAD     # ordinary push; open the PR however you like
gms add auth-api            # next layer
```

Set each PR's base to the branch below it so reviewers see only that layer's diff. `gms` never
creates or edits PRs — it reads them, and prints the command when something needs fixing.

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
single `git push --atomic` covering exactly the branches whose SHA changed.

On a conflict it stops, records where it was, and leaves you on the conflicted branch with
nothing pushed:

```sh
# resolve, then:
git add . && git commit
gms merge --continue     # or: gms merge --abort
```

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

### Looking around

```sh
gms ls              # the stack, with PR numbers as clickable links
gms ls --urls       # print the PR urls in full
gms ls --json       # for scripting; includes any interrupted merge walk
gms up / down / top / bottom
gms co auth-api     # or: gms co '#124'
```

PR numbers in `gms ls` are OSC 8 hyperlinks, so ⌘-click opens them. Piped output stays plain;
`GMS_NO_HYPERLINKS=1` disables them.

## State

- `~/.config/gms/config.json` — optional (`defaultTrunk`, `remote`).
- `~/.local/share/gms/stacks/<owner>__<repo>.json` — one file per repo.

`$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` are honored. State is keyed by the origin remote's
`owner/repo`, not by path, so every worktree of a repo shares one set of stacks and moving a
clone does not orphan them. Files are written atomically and pretty-printed — editing one by
hand is a supported way out of a mess.

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

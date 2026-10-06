#!/usr/bin/env bash
# End-to-end exercise of gms against a throwaway repo and a bare origin.
# Fully offline: `gh` is stubbed out with a fixture file, and XDG dirs are redirected,
# so this never touches your real stacks or talks to github.
#
# usage: test/integration.sh [run-dir]
set -uo pipefail

GMS_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${1:-$(mktemp -d "${TMPDIR:-/tmp}/gms-itest.XXXXXX")}"
TAG="$(basename "$RUN")"
ORIGIN="$RUN/origin.git"
WORK="$RUN/work"

export XDG_DATA_HOME="$RUN/xdg-data"
export XDG_CONFIG_HOME="$RUN/xdg-config"
export GMS_FAKE_PRS="$RUN/prs.json"
export PATH="$RUN/fakebin:$PATH"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

mkdir -p "$RUN/fakebin"
cat > "$RUN/fakebin/gh" <<'STUB'
#!/usr/bin/env bash
# gms only ever calls `gh pr list ... --json ...`; serve a fixture instead.
if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
	cat "${GMS_FAKE_PRS:-/dev/null}"
	exit 0
fi
echo "fake gh: unexpected args: $*" >&2
exit 1
STUB
chmod +x "$RUN/fakebin/gh"

gms() { (cd "$WORK" && "$GMS_REPO/bin/gms" "$@"); }
g()   { git -C "$WORK" "$@"; }

PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()   { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }
grepq() { if grep -q "$2" <<<"$1"; then ok "$3"; else bad "$3 -- output was: $1"; fi; }
nogrep(){ if grep -q "$2" <<<"$1"; then bad "$3"; else ok "$3"; fi; }
banner(){ echo ""; echo "== $1"; }
branches() { gms ls --json "$@" | python3 -c 'import json,sys
s=json.load(sys.stdin)["stacks"]
print(",".join(b["name"] for b in s[0]["branches"]) if s else "")'; }
pending_set() { gms ls --json | python3 -c 'import json,sys;print(json.load(sys.stdin).get("pending") is not None)'; }

echo "run dir: $RUN"
echo '[]' > "$GMS_FAKE_PRS"
git init -q --bare -b main "$ORIGIN"
git init -q -b main "$WORK"
g config commit.gpgsign false
g remote add origin "$ORIGIN"
commit(){ echo "$2" >> "$WORK/$1"; g add "$1" >/dev/null; g commit -qm "$3"; }
commit README "base" "initial"
g push -q -u origin main
g remote set-head origin main >/dev/null 2>&1

# --- 1. init + add ----------------------------------------------------------
banner "1. init / add x3"
out=$(gms init feature 2>&1); grepq "$out" "created stack feature" "init creates a stack"
check "trunk detected" "$(gms ls --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["trunk"])')" "main"

gms add a >/dev/null; commit a.txt "a1" "a1"
gms add b >/dev/null; commit b.txt "b1" "b1"
gms add c >/dev/null; commit c.txt "c1" "c1"
check "three branches tracked" \
  "$(branches)" \
  "a,b,c"
check "state file is where xdg says" "$(ls "$XDG_DATA_HOME/gms/stacks/")" "${TAG}__origin.json"

out=$(gms add b 2>&1); grepq "$out" "already exists" "add refuses an existing branch name"
g switch -q a
out=$(gms add zz 2>&1); grepq "$out" "tip of 'feature'" "add refuses to build off a non-tip branch"
if g show-ref --verify -q refs/heads/zz; then bad "refused add still created zz"; else ok "refused add created nothing"; fi
g switch -q c

# --- 2. dry run -------------------------------------------------------------
banner "2. merge --dry-run"
g switch -q main; commit t.txt "trunk1" "trunk moves"; g push -q origin main; g switch -q c
before_a=$(g rev-parse a)
out=$(gms merge -n 2>&1)
grepq "$out" "1. merge main into a" "plan step 1"
grepq "$out" "2. merge a into b"    "plan step 2"
grepq "$out" "3. merge b into c"    "plan step 3"
for ref in prev -1; do
	out=$(gms merge --from "$ref" -n 2>&1)
	grepq "$out" "1. merge b into c" "--from $ref plans one step"
	if grep -q "2\. merge" <<<"$out"; then bad "--from $ref planned more than one step"; else ok "--from $ref is only one step"; fi
done
check "dry run changed nothing" "$(g rev-parse a)" "$before_a"

# --- 3. the walk ------------------------------------------------------------
banner "3. merge (branches not yet on the remote stay local)"
out=$(gms merge 2>&1)
grepq "$out" "merged origin/main into a" "step 1 used the REMOTE trunk"
for br in a b c; do
  if g merge-base --is-ancestor origin/main "$br"; then ok "$br contains trunk"; else bad "$br missing trunk"; fi
done
if g merge-base --is-ancestor a c; then ok "c contains a (merged transitively)"; else bad "c missing a"; fi
check "3 merge commits" "$(g rev-list --merges --count origin/main..c)" "3"
check "returned to the starting branch" "$(g rev-parse --abbrev-ref HEAD)" "c"
grepq "$out" "no remote branch yet: a, b, c" "unpushed branches are named, not pushed"
nogrep "$out" "^pushing" "nothing was pushed"
for br in a b c; do
  if g show-ref --verify -q "refs/remotes/origin/$br"; then bad "merge published $br"; else ok "$br stayed local"; fi
done
check "no pending state left" "$(pending_set)" "False"

banner "3b. push publishes the stack"
out=$(gms push -n 2>&1)
grepq "$out" "would push 3 branch(es)" "dry run counts the branches"
if g show-ref --verify -q refs/remotes/origin/a; then bad "dry run pushed"; else ok "dry run pushed nothing"; fi

out=$(gms push 2>&1)
for br in a b c; do
  check "$br was pushed" "$(g rev-parse "$br")" "$(g rev-parse "origin/$br")"
done
grepq "$out" "gh pr create --repo .* --base main --head a" "suggests a pr against the branch below"
grepq "$out" "gh pr create --repo .* --base a --head b" "suggests b's pr against a"
out=$(gms push 2>&1); grepq "$out" "nothing to push" "a published stack has nothing to push"

banner "3c. merge pushes what is already published"
g switch -q main; commit t2.txt "trunk2" "trunk moves again"; g push -q origin main; g switch -q c
out=$(gms merge 2>&1)
grepq "$out" "pushing a, b, c" "published branches are pushed by merge"
for br in a b c; do
  check "$br is up to date on origin" "$(g rev-parse "$br")" "$(g rev-parse "origin/$br")"
done

# --- 4. idempotence ---------------------------------------------------------
banner "4. merge again"
sha_c=$(g rev-parse c)
out=$(gms merge 2>&1)
grepq "$out" "already up to date" "reports up to date"
nogrep "$out" "pushing" "nothing pushed"
check "no new commits" "$(g rev-parse c)" "$sha_c"

# --- 5. conflict: abort, then continue --------------------------------------
banner "5. conflict handling"
g switch -q a; echo A > "$WORK/shared.txt"; g add shared.txt >/dev/null; g commit -qm "a: shared"
g switch -q b; echo B > "$WORK/shared.txt"; g add shared.txt >/dev/null; g commit -qm "b: shared"
g switch -q c
c_before=$(g rev-parse c); b_before=$(g rev-parse b); origin_b_before=$(g rev-parse origin/b)

out=$(gms merge --from a --to c 2>&1); rc=$?
check "conflict exits nonzero" "$rc" "1"
grepq "$out" "conflict merging a into b" "conflict is reported"
grepq "$out" "shared.txt" "conflicted file is listed"
grepq "$out" "nothing has been pushed" "says nothing was pushed"
check "stopped on the conflicted branch" "$(g rev-parse --abbrev-ref HEAD)" "b"
check "top of stack untouched" "$(g rev-parse c)" "$c_before"
check "origin/b untouched" "$(g rev-parse origin/b)" "$origin_b_before"
check "pending recorded in --json" \
  "$(pending_set)" "True"
check "pending persisted to disk" \
  "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pending") is not None)' "$XDG_DATA_HOME/gms/stacks/${TAG}__origin.json")" "True"
grepq "$(gms ls)" "unfinished merge walk" "ls warns about the unfinished walk"

out=$(gms merge --abort 2>&1)
grepq "$out" "aborted the in-flight merge" "abort backs the merge out"
check "abort returned to the starting branch" "$(g rev-parse --abbrev-ref HEAD)" "c"
check "abort restored b" "$(g rev-parse b)" "$b_before"
check "pending cleared" \
  "$(pending_set)" "False"
out=$(gms merge -n --from a --to c 2>&1); grepq "$out" "merge plan" "a fresh plan works after abort"

gms merge --from a --to c >/dev/null 2>&1
echo resolved > "$WORK/shared.txt"; g add shared.txt >/dev/null; g commit -qm "resolve" >/dev/null
out=$(gms merge --continue 2>&1)
grepq "$out" "merged b into c" "continue finishes the rest of the walk"
if g merge-base --is-ancestor a c; then ok "c has a after resolve"; else bad "c missing a"; fi
check "b pushed after continue" "$(g rev-parse b)" "$(g rev-parse origin/b)"
check "c pushed after continue" "$(g rev-parse c)" "$(g rev-parse origin/c)"
check "back on the starting branch" "$(g rev-parse --abbrev-ref HEAD)" "c"

out=$(gms merge --continue 2>&1); grepq "$out" "no merge walk to continue" "continue with nothing pending errors"

# --- 6. sync: merged branches ----------------------------------------------
banner "6. sync after a PR lands"
cat > "$GMS_FAKE_PRS" <<JSON
[{"number":1,"state":"MERGED","headRefName":"a","baseRefName":"main","url":"https://github.test/test/repo/pull/1","title":"a"},
 {"number":2,"state":"OPEN","headRefName":"b","baseRefName":"a","url":"https://github.test/test/repo/pull/2","title":"b"},
 {"number":3,"state":"OPEN","headRefName":"c","baseRefName":"b","url":"https://github.test/test/repo/pull/3","title":"c"}]
JSON
g switch -q main; g merge -q --no-ff -m "merge a" a; g push -q origin main
g push -q origin --delete a; g switch -q c

out=$(gms sync --stack feature -n 2>&1)
grepq "$out" "merged, remote deleted" "a is merged-remote-gone"
grepq "$out" "re-link b: parent a -> main" "b re-links onto trunk"
grepq "$out" "branch -d a" "prints the delete command"
grepq "$out" "gh pr edit 2 --repo" "reports the stale pr base"
grepq "$out" "dry run: nothing was changed" "dry run says so"
check "dry run left a tracked" \
  "$(branches)" "a,b,c"

out=$(gms sync --stack feature 2>&1)
check "a untracked" \
  "$(branches)" "b,c"
if g show-ref --verify -q refs/heads/a; then ok "sync did NOT delete local a"; else bad "sync deleted a branch"; fi
check "pr url cached for c" \
  "$(gms ls --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["stacks"][0]["branches"][1]["prUrl"])')" \
  "https://github.test/test/repo/pull/3"
grepq "$(gms ls --urls)" "https://github.test/test/repo/pull/3" "ls --urls prints pr urls"

banner "6b. sync --prune deletes a landed branch"
cat > "$GMS_FAKE_PRS" <<JSON
[{"number":2,"state":"MERGED","headRefName":"b","baseRefName":"main","url":"https://github.test/test/repo/pull/2","title":"b"},
 {"number":3,"state":"OPEN","headRefName":"c","baseRefName":"b","url":"https://github.test/test/repo/pull/3","title":"c"}]
JSON
g switch -q main; g merge -q --no-ff -m "merge b" b; g push -q origin main
g push -q origin --delete b; g switch -q c
out=$(gms sync --stack feature --prune 2>&1)
grepq "$out" "deleted local branch b" "prune deletes the landed branch"
if g show-ref --verify -q refs/heads/b; then bad "b survived --prune"; else ok "local b is gone"; fi
check "only c left" \
  "$(branches)" "c"

# --- 7. pruned-branch edge cases -------------------------------------------
banner "7. gone / abandoned / never-pushed"
echo '[]' > "$GMS_FAKE_PRS"
g switch -q main
gms init edge >/dev/null
gms add x >/dev/null; commit x.txt x1 x1; g push -q -u origin x
gms add y >/dev/null; commit y.txt y1 y1; g push -q -u origin y
gms add z >/dev/null; commit z.txt z1 z1          # deliberately never pushed
g switch -q main
g push -q origin --delete x                        # remote deleted, NOT merged
g branch -D y >/dev/null 2>&1                      # local deleted by hand

out=$(gms sync --stack edge 2>&1)
grepq "$out" "abandoned (remote deleted, not merged)" "x is abandoned"
grepq "$out" "may hold commits that exist nowhere else" "abandoned is explained"
grepq "$out" "gone (no local branch)" "y is gone"
grepq "$out" "re-run with --prune to untrack" "gone needs --prune"
grepq "$out" "new (never pushed)" "z is new"
check "sync alone dropped nothing" \
  "$(branches --stack edge)" "x,y,z"

out=$(gms sync --stack edge --prune 2>&1)
check "prune untracked only the gone branch" \
  "$(branches --stack edge)" "x,z"
if g show-ref --verify -q refs/heads/x; then ok "prune left abandoned x alone"; else bad "prune deleted abandoned x"; fi
if g show-ref --verify -q refs/heads/z; then ok "prune left never-pushed z alone"; else bad "prune deleted z"; fi
grepq "$out" "re-link z: parent y -> x" "z re-links over the pruned branch"

# --- 7b. push: scope, skips, and divergence ---------------------------------
banner "7b. push scope"
echo '[]' > "$GMS_FAKE_PRS"
g switch -q main
gms init pushy >/dev/null
gms add p1 >/dev/null; commit p1.txt p1 p1
gms add p2 >/dev/null; commit p2.txt p2 p2
gms add p3 >/dev/null; commit p3.txt p3 p3
g switch -q p2

out=$(gms push 2>&1)
grepq "$out" "pushing 2 branch(es)" "default stops at the current branch"
check "p1 published" "$(g rev-parse p1)" "$(g rev-parse origin/p1)"
check "p2 published" "$(g rev-parse p2)" "$(g rev-parse origin/p2)"
if g show-ref --verify -q refs/remotes/origin/p3; then bad "pushed above the current branch"; else ok "p3 above HEAD untouched"; fi

out=$(gms push --all 2>&1)
grepq "$out" "up to date" "already-published branches are skipped"
check "p3 published under --all" "$(g rev-parse p3)" "$(g rev-parse origin/p3)"

commit p2.txt p2more "p2 again"                    # a new commit on a published branch
out=$(gms push -n 2>&1)
grepq "$out" "↑1" "an unpushed commit shows as ahead"
grepq "$out" "dry run: nothing was pushed" "dry run says so"
if g merge-base --is-ancestor p2 origin/p2; then bad "dry run pushed"; else ok "dry run pushed nothing"; fi

banner "7c. push refuses to force"
g switch -q -c divergent p2~1
commit d.txt d "divergent"
g push -q -f origin divergent:p2                   # someone else rewrote origin/p2
g fetch -q origin
g switch -q p2
out=$(gms push 2>&1); rc=$?
check "diverged push exits nonzero" "$rc" "1"
grepq "$out" "diverged from origin" "divergence is named"
grepq "$out" "never force-pushes" "and the refusal is explained"
nogrep "$out" "pushing" "nothing was attempted"

g push -q -f origin p2                             # put origin/p2 back under the local branch
g fetch -q origin

# --- 7d. markdown for pr descriptions ---------------------------------------
banner "7d. ls --markdown"
cat > "$GMS_FAKE_PRS" <<JSON
[{"number":11,"state":"OPEN","headRefName":"p1","baseRefName":"main","url":"https://github.test/test/repo/pull/11","title":"first layer"},
 {"number":12,"state":"OPEN","headRefName":"p2","baseRefName":"p1","url":"https://github.test/test/repo/pull/12","title":"second layer"}]
JSON
gms sync --stack pushy >/dev/null 2>&1
g switch -q p2

out=$(gms ls --stack pushy --markdown 2>&1)
grepq "$out" "bottom → top, base" "header names the base"
grepq "$out" "#11 first layer](https://github.test/test/repo/pull/11)" "entries carry the pr title"
grepq "$out" "3. .(next layer — no PR yet)" "a branch without a pr is a placeholder"
nogrep "$out" "p1" "no branch name reaches the markdown"
nogrep "$out" "p3" "not even for the branch with no pr"
nogrep "$out" "this PR" "nothing is marked by default"

out=$(gms ls --stack pushy --markdown --for-current 2>&1)
grepq "$out" "#12 second layer](https://github.test/test/repo/pull/12) 👈" "--for-current marks the checked-out branch"
out=$(gms ls --stack pushy --markdown --for p1 2>&1)
grepq "$out" "#11 first layer](https://github.test/test/repo/pull/11) 👈" "--for moves the marker"
out=$(gms ls --stack pushy --markdown --for nope 2>&1)
grepq "$out" "not in stack" "--for outside the stack is refused"
out=$(gms ls --stack pushy --markdown --json 2>&1)
grepq "$out" "different formats" "--json with --markdown is refused"
out=$(gms ls --stack pushy --for-current 2>&1)
grepq "$out" "only mean anything with --markdown" "--for-current without --markdown is refused"

# --- 7e. changeset ----------------------------------------------------------
# `pnpm` is stubbed the same way `gh` is, so we can read back the exact argv gms built.
banner "7e. changeset"
cat > "$RUN/fakebin/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "fake pnpm: $*"
STUB
chmod +x "$RUN/fakebin/pnpm"

g switch -q x
out=$(gms changeset 2>&1)
grepq "$out" "fake pnpm: changeset$" "bottom of the stack gets no --since"

g switch -q z
out=$(gms changeset 2>&1)
grepq "$out" "fake pnpm: changeset --since x" "higher up, --since is the branch below"

out=$(gms changeset -n 2>&1)
grepq "$out" "pnpm changeset --since x" "dry run prints the command"
nogrep "$out" "fake pnpm" "dry run ran nothing"

g switch -q main
out=$(gms changeset --stack edge 2>&1); grepq "$out" "not in stack 'edge'" "off-stack branch refused"

# --- 8. misc guards ---------------------------------------------------------
banner "8. guards"
g switch -q z; echo dirty >> "$WORK/z.txt"
out=$(gms merge 2>&1); grepq "$out" "working tree is dirty" "merge refuses a dirty tree"
g checkout -q -- z.txt
out=$(gms merge --from z --to x 2>&1); grepq "$out" "only merges upward" "downward range refused"
out=$(gms merge --to nope 2>&1); grepq "$out" "not in stack" "unknown branch refused"
out=$(gms nope 2>&1); grepq "$out" "unknown command" "unknown command refused"
out=$(gms untrack z 2>&1); grepq "$out" "branch -d z" "untrack prints the delete command"
if g show-ref --verify -q refs/heads/z; then ok "untrack did not delete z"; else bad "untrack deleted z"; fi

# The shim is normally reached through a symlink in ~/.local/bin, so resolving
# BASH_SOURCE through links is load-bearing, not cosmetic.
ln -sf "$GMS_REPO/bin/gms" "$RUN/fakebin/gms-linked"
out=$("$RUN/fakebin/gms-linked" --help 2>&1)
grepq "$out" "never rebasing" "bin/gms works when invoked through a symlink"

# --- 9. the trunk is repo-wide -----------------------------------------------
# `gms init --trunk` used to write state.trunk unconditionally, silently re-basing
# every other stack in the repo. It must refuse, and point at `gms trunk`.
banner "9. trunk safety"
trunk_of() { gms ls --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["trunk"])'; }
STATE_FILE=$(ls "$XDG_DATA_HOME"/gms/stacks/*.json | head -1)

check "trunk starts as main" "$(trunk_of)" "main"
out=$(gms trunk 2>&1); grepq "$out" "trunk: main" "gms trunk reports the current trunk"

out=$(gms init newstack --trunk z 2>&1)
grepq "$out" "would move the trunk from 'main' to 'z'" "init --trunk refused once stacks exist"
grepq "$out" "gms trunk z" "the refusal names the command that does mean it"
check "refused init left the trunk alone" "$(trunk_of)" "main"
out=$(gms stacks 2>&1); nogrep "$out" "newstack" "refused init created no stack"

out=$(gms init another --trunk p1 2>&1)
grepq "$out" "tracked in stack 'pushy'" "a tracked branch cannot become the trunk"
out=$(gms trunk p1 2>&1)
grepq "$out" "tracked in stack 'pushy'" "gms trunk refuses a tracked branch too"

out=$(gms trunk z 2>&1)
grepq "$out" "trunk main -> z" "gms trunk moves the trunk"
grepq "$out" "no branches were changed" "gms trunk narrates that it touched no refs"
check "trunk moved" "$(trunk_of)" "z"

# The corruption this whole section exists to prevent: trunk that is also a stack member.
python3 -c "
import json,sys
f='$STATE_FILE'
s=json.load(open(f))
s['trunk']='p1'
json.dump(s,open(f,'w'),indent=2)
"
out=$(gms ls 2>&1 >/dev/null)
grepq "$out" "both the trunk and a member of stack 'pushy'" "bad state warns on stderr"
if gms ls --json 2>/dev/null | python3 -c 'import json,sys;json.load(sys.stdin)' 2>/dev/null; then
  ok "the warning does not corrupt --json stdout"
else
  bad "the warning does not corrupt --json stdout"
fi
out=$(gms trunk main 2>&1); grepq "$out" "trunk p1 -> main" "gms trunk repairs a hand-broken trunk"
check "trunk repaired" "$(trunk_of)" "main"
out=$(gms ls 2>&1 >/dev/null); nogrep "$out" "warning:" "repaired state warns about nothing"

echo ""
echo "================ $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

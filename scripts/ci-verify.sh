#!/usr/bin/env bash
# The whole CI gate, runnable locally: `bun run ci`.
#
# 1. The template-clean check runs first and alone, so a leaked secret fails
#    before anything else reads the tree.
# 2. Tests run alongside typecheck-then-build. The build cannot overlap the
#    typecheck: it writes .svelte-kit/{output,cloudflare,cloudflare-tmp},
#    and svelte-check reports thousands of errors in those files if they exist
#    while it runs. Tests read neither, so they overlap both.
#
# Stale build output is removed before the typecheck, so `bun run ci` also
# works locally after a `bun run build` (a plain `bun run check` does not).
#
# Every task always runs to the end; the script fails if any of them failed and
# prints the log of each. Set CI_SERIAL=1 to run them one after another
# instead (use it if a parallel run ever looks flaky).
set -uo pipefail

cd "$(dirname "$0")/.."

in_actions=${GITHUB_ACTIONS:-}
group() { if [ -n "$in_actions" ]; then echo "::group::$1"; else echo "== $1"; fi; }
endgroup() { if [ -n "$in_actions" ]; then echo "::endgroup::"; fi; }
now() { date +%s; }

group "Check the template is clean"
bun run check:clean || { endgroup; echo "Template is not clean; stopping." >&2; exit 1; }
endgroup

# Build output from an earlier build would be typechecked; clear it, then
# generate .svelte-kit once so the typecheck sees a complete tree.
rm -rf .svelte-kit/output .svelte-kit/cloudflare .svelte-kit/cloudflare-tmp
bunx svelte-kit sync >/dev/null || { echo "svelte-kit sync failed" >&2; exit 1; }

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT

NAMES=(Typecheck Test Build)
CMDS=(
	"bunx svelte-check --tsconfig ./tsconfig.json"
	"bun test tests"
	"bun run build"
)

run_task() { # index
	local start; start=$(now)
	bash -c "${CMDS[$1]}" >"$logs/$1.log" 2>&1
	echo $? >"$logs/$1.rc"
	echo $(( $(now) - start )) >"$logs/$1.secs"
}

if [ "${CI_SERIAL:-}" = 1 ]; then
	for i in "${!NAMES[@]}"; do run_task "$i"; done
else
	# Build runs after the typecheck whatever its result, so one run reports
	# every failure.
	{ run_task 0; run_task 2; } &
	run_task 1 &
	wait
fi

failed=0
summary="| Task | Result | Seconds |\n|---|---|---|\n"
for i in "${!NAMES[@]}"; do
	rc=$(cat "$logs/$i.rc" 2>/dev/null || echo 1)
	secs=$(cat "$logs/$i.secs" 2>/dev/null || echo "?")
	if [ "$rc" = 0 ]; then
		result=pass
		group "${NAMES[$i]} (pass, ${secs}s)"; cat "$logs/$i.log"; endgroup
	else
		result="FAIL ($rc)"; failed=1
		# Failures stay outside a group so they are open in the Actions log.
		echo "== ${NAMES[$i]} FAILED (exit $rc, ${secs}s)"
		cat "$logs/$i.log"
		[ -n "$in_actions" ] && echo "::error title=${NAMES[$i]} failed::exit $rc, see the log above"
	fi
	summary+="| ${NAMES[$i]} | $result | $secs |\n"
done

[ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf "$summary" >>"$GITHUB_STEP_SUMMARY"
printf "$summary"
exit $failed

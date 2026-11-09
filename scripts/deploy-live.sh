#!/usr/bin/env bash
# Ship main to a live deployment, safely.
#
#   bun run deploy:live <name>      # uses wrangler.<name>.jsonc (gitignored)
#
# In order: refuses unless this is a clean, up-to-date main; says whether the
# version now live came from this repo (another checkout deploying to the same
# Worker overwrites it); backs up the remote D1 database; applies migrations;
# builds; deploys with the commit in the version message, retrying Cloudflare
# timeouts; checks the site answers.
#
# Backups go to $CLOUDMAIL_BACKUP_DIR, or ../cloudmail-backups beside the repo.
set -euo pipefail

name="${1:-}"
if [[ -z "$name" ]]; then
	echo "usage: bun run deploy:live <name>   (reads wrangler.<name>.jsonc)" >&2
	exit 2
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"
config="wrangler.${name}.jsonc"
[[ -f "$config" ]] || { echo "no $config in $root" >&2; exit 2; }

wrangler() { CI=1 bunx wrangler "$@" -c "$config"; }

# Only main, exactly as merged.
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || { echo "on $branch: deploy only from main" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "uncommitted changes: commit or stash first" >&2; exit 1; }
git fetch -q origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || {
	echo "main isn't origin/main: run git pull first" >&2
	exit 1
}
sha="$(git rev-parse --short HEAD)"
message="cloudmail ${sha}"

# Was the live version deployed by this script? If not, something else wrote over it.
live_version="$(wrangler deployments list --json 2>/dev/null | bun -e '
	const list = JSON.parse(await Bun.stdin.text());
	console.log(list.at(-1)?.versions?.[0]?.version_id ?? "");
' 2>/dev/null || true)"
live=""
if [[ -n "$live_version" ]]; then
	live="$(wrangler versions view "$live_version" --json 2>/dev/null | bun -e '
		const version = JSON.parse(await Bun.stdin.text());
		console.log(version.annotations?.["workers/message"] ?? "");
	' 2>/dev/null || true)"
fi
if [[ "$live" == cloudmail\ * ]]; then
	echo "live now: $live"
else
	echo "warning: the live version wasn't deployed from cloudmail (message: '${live:-none}')."
	echo "         Another checkout may be deploying to this Worker. This deploy replaces it."
fi

# Back up before anything touches the database.
backups="${CLOUDMAIL_BACKUP_DIR:-$(dirname "$root")/cloudmail-backups}"
mkdir -p "$backups"
backup="$backups/${name}-d1-$(date +%Y%m%d-%H%M%S).sql"
wrangler d1 export DB --remote --output "$backup" >/dev/null
[[ -s "$backup" ]] || { echo "backup is empty: stopping" >&2; exit 1; }
echo "backup: $backup ($(du -h "$backup" | cut -f1))"

wrangler d1 migrations apply DB --remote

rm -rf .svelte-kit
bun run build

# Cloudflare's API sometimes answers 504 mid-upload; nothing goes live then, so retry.
for attempt in 1 2 3; do
	if wrangler deploy --message "$message"; then
		break
	fi
	[[ $attempt -lt 3 ]] || { echo "deploy failed 3 times" >&2; exit 1; }
	echo "deploy attempt $attempt failed; retrying in 15s"
	sleep 15
done

url="$(grep -o '"pattern": *"[^"*]*"' "$config" | grep -v '/' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
if [[ -n "$url" ]]; then
	code="$(curl -s -o /dev/null -w '%{http_code}' "https://$url/login")"
	echo "https://$url/login answered $code"
	[[ "$code" == "200" ]] || exit 1
fi
echo "deployed $message"

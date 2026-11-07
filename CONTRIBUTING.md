# Contributing to CloudMail

Thanks for helping out. CloudMail handles people's mail, so we favour small,
well-tested changes over big ones.

## Before you start

- **Bugs:** open an issue using the bug report form. Include steps to reproduce,
  and say which mail provider you use (Resend or Cloudflare Email Service).
- **Features or anything large:** open an issue first and wait for a maintainer
  to agree on the approach. Then send the PR. Unannounced large PRs may be closed,
  even if they're good, because they can conflict with the roadmap.
- **Questions and ideas:** use [Discussions](../../discussions), not issues.
- **Security problems:** never in a public issue. See [SECURITY.md](SECURITY.md).

Issues labelled `good first issue` are a good place to start.

## Local setup

You need [Bun](https://bun.sh) 1.4+. You don't need a Cloudflare account to develop locally.

```bash
bun install
cp .dev.vars.example .dev.vars
bun run db:migrate:local
DEMO_MODE=true bun run dev       # http://localhost:5173, sample data, no provider
```

Demo mode reads `DEMO_MODE` from the dev server's process environment, so set it
on the command as above. Putting it in `.dev.vars` doesn't turn it on. Leave it
off (`bun run dev`) once you've set up a real provider; see the README for that.

## Before you open a PR

Run the same checks CI runs:

```bash
bun run check:clean   # no secrets, account ids, or personal hostnames
bun run check         # typecheck
bun run test          # unit tests
bun run build
```

- **Add or update tests** in `tests/` for any behaviour you change.
- **Database changes** go in a new numbered file in `migrations/`. Never edit a
  migration that has already been released. Call out the migration in your PR.
- **Never commit secrets**, real API keys, Cloudflare account ids, or your own
  domain. Use `example.com` and placeholders. `check:clean` catches the common
  formats, but not everything (for example an account id in a plain variable, or
  a hostname outside the Wrangler routes), so read through your diff as well.
- **UI changes:** include before/after screenshots. If you can, check both light
  and dark mode and a phone-width screen.

## Pull requests

- Branch from `main`. Keep each PR to one change.
- Write PR titles in [Conventional Commits](https://www.conventionalcommits.org)
  style, e.g. `fix(compose): keep signature when switching From`. PRs are
  squash-merged, so the title becomes the commit message and the changelog entry.
- CI must pass. An automated reviewer may comment. Treat its comments as
  suggestions; a maintainer makes the final call.
- Every PR gets a risk label from the files it changes
  ([`scripts/risk-tier.mjs`](scripts/risk-tier.mjs)):
  - `risk:low`: only docs, tests, styles, and raster images.
  - `risk:high`: anything else, including every `.svelte` file, sign-in,
    sessions, sending mail, migrations, agents, dependencies, and CI.

  The maintainer's own `risk:low` PRs (every commit theirs), and Dependabot's
  patch and minor updates that change only `package.json` and lockfiles, merge
  on their own once CI passes. A `risk:high` PR, or any PR from
  anyone else, waits for a maintainer. Add the `hold` label to stop a PR from
  merging on its own.
- Expect a first response within about a week.

## License

CloudMail is licensed under [Apache-2.0](LICENSE). By submitting a contribution
you agree it is licensed under the same terms (Apache-2.0, section 5).

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

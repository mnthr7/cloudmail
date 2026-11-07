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
cp .dev.vars.example .dev.vars   # or: echo "DEMO_MODE=true" > .dev.vars
bun run db:migrate:local
bun run dev                      # http://localhost:5173
```

`DEMO_MODE=true` runs the UI with sample data and no mail provider. See the
README for full provider setup.

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
  domain. Use `example.com` and placeholders. `check:clean` will fail if you do.
- **UI changes:** include before/after screenshots. If you can, check both light
  and dark mode and a phone-width screen.

## Pull requests

- Branch from `main`. Keep each PR to one change.
- Write PR titles in [Conventional Commits](https://www.conventionalcommits.org)
  style, e.g. `fix(compose): keep signature when switching From`. PRs are
  squash-merged, so the title becomes the commit message and the changelog entry.
- CI must pass. An automated reviewer may comment. Treat its comments as
  suggestions; a maintainer makes the final call.
- Expect a first response within about a week.

## License

CloudMail is licensed under [Apache-2.0](LICENSE). By submitting a contribution
you agree it is licensed under the same terms (Apache-2.0, section 5).

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

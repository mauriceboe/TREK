# Contributing to TREK

Thanks for your interest in contributing! Please read these guidelines before opening a pull request.

## Ground Rules

1. **Ask in Discord first** — Before writing any code, pitch your idea in the `#github-pr` channel on our [Discord server](https://discord.gg/P7TUxHJs). We'll let you know if the PR is wanted and give direction. PRs that show up without prior discussion will be closed
2. **One change per PR** — Keep it focused. Don't bundle unrelated fixes or refactors
3. **No breaking changes** — Backwards compatibility is non-negotiable
4. **Target the `dev` branch** — All PRs must be opened against `dev`, not `main`
5. **Match the existing style** — No reformatting, no linter config changes, no "while I'm here" cleanups
6. **Tests** — Your changes must include tests. The project maintains 80%+ coverage; PRs that drop it will be closed
7. **Branch up to date** — Your branch must be [up to date with `dev`](https://github.com/mauriceboe/TREK/wiki/Development-environment#3-keep-your-fork-up-to-date) before submitting a PR

## Pull Requests

### Your PR should include:

- **Summary** — What does this change and why? (1-3 bullet points)
- **Test plan** — How did you verify it works?
- **Linked issue** — Reference the issue (e.g. `Fixes #123`)

### Your PR will be closed if it:

- Wasn't discussed and approved in `#github-pr` on Discord first
- Introduces breaking changes
- Adds unnecessary complexity or features beyond scope
- Reformats or refactors unrelated code
- Adds dependencies without clear justification

### Commit messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
fix(maps): correct zoom level on Safari
feat(budget): add CSV export for expenses
```

## Development Environment

See the [Developer Environment page](https://github.com/mauriceboe/TREK/wiki/Development-environment) for more information on setting up your development environment.

## More Details

See the [Contributing wiki page](https://github.com/mauriceboe/TREK/wiki/Contributing) for the full tech stack, architecture overview, and detailed guidelines.

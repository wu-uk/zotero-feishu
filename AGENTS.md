# Repository Guidelines

## Project Goal

Build a Zotero plugin that synchronizes literature metadata and notes to Feishu
cloud documents. Prioritize reliable authentication, stable Zotero-to-Feishu
identity mapping, repeatable incremental synchronization, and actionable error
reporting. Keep Feishu API access separate from Zotero data extraction, and avoid
expanding unrelated template examples.

## Project Structure & Module Organization

- `src/` holds TypeScript logic; put features in `src/modules/` and shared helpers
  in `src/utils/`.
- `addon/` holds packaged manifests, bootstrap code, preferences, styles, icons,
  and Fluent translations under `addon/locale/<locale>/`.
- `test/` contains integration tests; `typings/` contains local declarations;
  translated documentation lives in `doc/`.
- Generated output is written to `build/` and `.scaffold/`; do not commit it.

## Build, Test, and Development Commands

Run `npm install`, then copy `.env.example` to `.env` and configure a Zotero binary
and dedicated development profile.

- `npm start`: launches Zotero and reloads changed plugin files.
- `npm run build`: packages production output and type-checks TypeScript.
- `npm test`: runs the Zotero-hosted Mocha test suite.
- `npm run lint:check`: checks Prettier formatting and ESLint rules.
- `npm run lint:fix`: applies automatic formatting and lint fixes.

Before a pull request, run `npm run lint:check`, `npm run build`, and `npm test`.

## Coding Style & Naming Conventions

Use TypeScript with ES modules, two-space indentation, LF line endings, and an
80-column target. Use `camelCase` for values, `PascalCase` for types, and descriptive
module names such as `preferenceScript.ts`. Keep locale keys synchronized across
`en-US` and `zh-CN`. Prettier and ESLint are authoritative.

## Testing Guidelines

Tests use Mocha with Chai assertions and should be named `*.test.ts` under `test/`.
Cover startup hooks, registrations, sync behavior, and regressions. Tests run in
Zotero and require valid `.env` paths. No coverage threshold is currently enforced.

## Commit & Pull Request Guidelines

Use Conventional Commits in the form `type(scope): subject`, for example
`feat(sync): export Zotero notes to Feishu`. Allowed types are `feat`, `fix`,
`docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`.
Recommended scopes include `zotero`, `feishu`, `sync`, `auth`, `ui`, `i18n`, and
`config`.

- Write the subject in imperative mood, lowercase, without a trailing period;
  keep the header at 72 characters or fewer.
- Keep each commit atomic. Do not mix formatting, refactoring, and behavior changes
  unless they cannot be separated safely.
- Explain motivation and important tradeoffs in the body. Mark incompatible changes
  with `!` and a `BREAKING CHANGE:` footer.
- Name branches `feat/<topic>`, `fix/<topic>`, or `chore/<topic>` using short
  kebab-case topics.

Before committing, review `git diff` and run the relevant lint, build, and test
commands. Pull requests must explain behavior and motivation, link relevant
issues, list verification performed, and include screenshots for UI changes.
Never commit `.env`, tokens, Zotero profile data, logs, or generated packages.

## Agent Workflow

Agents must inspect existing patterns before editing, keep changes scoped, and
report verification results. After implementation and checks are complete, the
agent must proactively ask whether the user wants the changes committed. Never
create a commit without the user's explicit confirmation.

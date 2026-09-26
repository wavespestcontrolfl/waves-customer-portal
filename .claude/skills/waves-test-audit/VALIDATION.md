# Waves test execution

Use the selected checkout's `.nvmrc`, installed dependencies, package scripts,
test setup, and `.github/workflows/tests.yml` as the authorities. Commands
below run from the repository root; replace `selected.test.js` with the
actual in-scope path. Do not install a new test framework for an audit.

## Client: Vitest

`client/package.json` owns `test` (`vitest run`); `client/vite.config.js`
owns setup and the focused customer-app coverage floor.

```sh
npm --prefix client test -- src/selected.test.js
```

Run affected sibling tests explicitly. If changing the measured customer-app
surface or its tests, also run `npm --prefix client run test:coverage`.
The CI client job additionally builds the app. Follow the existing brand
check and shipping requirements when a diff touches `client/`.

## Server: Jest with two different database modes

`server/package.json` owns `test` (`jest --coverage`). For a focused baseline,
disable aggregate coverage collection rather than interpreting a partial run
as the suite's coverage result:

```sh
env -u DATABASE_URL NODE_ENV=test npm --prefix server test -- --ci --runInBand --coverage=false --runTestsByPath tests/selected.test.js
```

Before using that no-database command, inspect the selected tests and imported
setup for other database selectors, dotenv loading, and provider calls. Clear
suite-specific database variables as needed; unsetting `DATABASE_URL` alone
does not guarantee isolation. Do not copy production `.env` files or service
credentials into the test environment. Tests must use mocked integrations or
the repository's explicitly isolated QA setup.

The broad CI Jest run deliberately has **no `DATABASE_URL`**: pricing golden
masters use in-memory semantics, and setting a migrated database globally
changes their meaning. Separate CI steps run database suites serially against
migrated PostgreSQL with pgvector. Some suites select `DATABASE_URL`; others
require a specific `*_TEST_DATABASE_URL` and may enforce disposable database
names. Read the chosen suite and its CI step to identify the exact selector,
schema, fixtures, and cleanup. Use `docs/development.md` and `waves-db` when
real database setup or schema verification is needed. Never use production.

A skipped database suite is **unverified**, not a passing substitute for
transaction proof. Do not remove its assertions based on a green no-DB run.
Preserve `.github/workflows/tests.yml` routing when moving or consolidating
tests: the generic DB lane discovers a particular skip declaration, while
other lanes explicitly list files. Preserve the focused customer coverage
gate in `server/jest.customer-coverage.config.js` and its npm script.

## Checks and evidence

- Run commands directly and inspect their exit codes; piping through `tail`
  or a search command can hide failures.
- `npm run test:contracts` can reach integrations when credentials are loaded.
  It is not a default test-audit command. Inspect its setup and use it only
  for an applicable contract in an isolated environment.
- Do not run migrations or start the full application for a source-only audit.
- Keep before/after measurements on the same revision base, runner, selected
  tests, and environment. Record failures and skips as well as duration.
- Check `git diff --check`, the final diff, and all checks required for the
  actual change. Restore every mutation probe before committing. Do not lower
  coverage thresholds or bypass a failing check to complete an audit.

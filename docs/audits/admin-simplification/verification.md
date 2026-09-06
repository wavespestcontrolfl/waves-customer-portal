# Verification and implementation evidence

Baseline `32de1dc5ccb5a2f9b6e5969db319df37b96a025d`; task-owned branch/worktree recorded in README. Commands ran with `/private/tmp/node-v20.20.2-darwin-arm64/bin` prepended to PATH. No production or dev database was connected. No migrations ran. Source inventory and risk/parity/deletion assessments were recorded before production edits.

## Baseline

| Check | Result | Evidence |
|---|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | Passed; existing lockfile, 1,507 packages, no package changes | Separate node_modules in this worktree |
| `npm run worktree:setup`; `npm run dev:doctor -- --frontend` | Passed, Node 20.20.2, integration credentials excluded, background jobs disabled | `.tmp/dev/`; frontend only, migrations not checked |
| `npm run build` | Passed, 115 seconds; schema/vendor/brand/domain prebuild gates passed | `.tmp/simplification/baseline-build.log`; existing stale Browserslist-data advisory |
| `npm run test:coverage --workspace client` | **1 failed / 260 passed suites; 1 failed / 2,485 passed tests** | `.tmp/simplification/baseline-client.log`; `PortalPage.silent-failures.test.jsx` could not find visit-preferences error text |
| `npm test --workspace client -- src/pages/PortalPage.silent-failures.test.jsx` | 8/8 passed in isolation | `.tmp/simplification/baseline-client-retry.log`; baseline concurrency/timing sensitivity, not treated as a clean first run |
| `NODE_ENV=test JWT_SECRET=<synthetic> node node_modules/jest/bin/jest.js --rootDir server --ci --silent --maxWorkers=2` | **1,847 passed suites / 25 skipped; 40,418 passed tests / 194 skipped; 3 snapshots passed** | `.tmp/simplification/baseline-server.log`; external network blocked via test-only `NODE_OPTIONS` preload; no DB/integration credentials |
| Static inventory collector | 68 admin child routes + shell, 4 auth-related route entries, 695 relevant modules, 2,503 entry-point references; zero parse errors | CSV snapshots and ignored raw inventory; computed references remain explicitly unresolved |

Full DB-gated integration/contracts/native device flows require a dedicated verified development database/device setup. They are not represented by the no-DB test count. Live tool contract smoke can invoke providers, so it is not run as a substitute for mocked testing. No full-server startup or new production analytics occurred.

## Implementation and final checks

To be completed after the selected slices. Until recorded here, proposed tests and screenshot scenarios in parity-and-routes.md are requirements, not completed evidence.

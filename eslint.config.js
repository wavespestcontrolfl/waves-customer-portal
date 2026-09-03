// Errors-only lint for staged files (wired via lint-staged in the
// scripts/hooks/pre-commit hook). Deliberately NOT a style linter: rules
// here catch code that is broken (undefined identifiers, duplicate keys,
// unreachable code), never how it looks. The repo has no lint history, so
// enforcement is changed-files-only — untouched legacy code is never
// flagged. Escape hatch: git commit -n
//
// ONE deliberate exception to "broken code only": the two structural
// warnings in QUALITY_WARN (cyclomatic complexity, nesting depth). They
// never block a commit — they exist so the author sees the number before
// Codex does, because "this function decides too much" is the single most
// repeated Codex simplification finding (CLAUDE.md rule 20). Policy: a
// warning on a function the diff ADDS or REWRITES is a P2 for review; a
// warning on untouched legacy code is noise and is ignored. Thresholds were
// set from a baseline over the whole non-test tree so that only the top
// ~4% of existing functions trip them (see PR #3787 for the distribution).
const globals = require('globals');
const react = require('eslint-plugin-react');

// Structural warnings (see header). Every production block (server, shared,
// scripts, ops, packages, client/src, client/public, video) — test files,
// test setup and __fixtures__ modules are exempt: a describe() body with
// many cases or a fixture builder is not a decision tree, and the counter
// would just teach people to split suites.
const QUALITY_WARN = {
  complexity: ['warn', { max: 20 }],
  'max-depth': ['warn', 4],
};

const ERRORS_ONLY = {
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-const-assign': 'error',
  'no-unreachable': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  // Signal without blocking: unused vars are worth seeing but --fix can't
  // remove them, and blocking commits on pre-existing ones in legacy files
  // would train everyone to bypass the hook.
  'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
};

const SOURCE_RULES = { ...ERRORS_ONLY, ...QUALITY_WARN };

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      'client/dist/**',
      'client/android/**',
      'ios/**',
      'exports/**',
      'wiki/**',
    ],
  },
  // Server, scripts, ops, packages — CommonJS on Node. (video/ is NOT here:
  // its package.json has "type": "module", so its .js files are ESM.)
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'ops/**/*.js', 'packages/**/*.js', 'shared/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: SOURCE_RULES,
  },
  // Jest tests (server + packages ONLY — client tests are vitest and must
  // not inherit jest globals; flat config merges globals across every
  // matching block, so client/** is excluded here rather than relying on
  // the later vitest block to win).
  {
    files: ['**/*.test.js', '**/tests/**/*.js', '**/contract-tests/**/*.js', '**/__mocks__/**/*.js', '**/__fixtures__/**/*.js'],
    ignores: ['client/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
    rules: { ...ERRORS_ONLY, complexity: 'off', 'max-depth': 'off' },
  },
  // Client — ESM + JSX in the browser. eslint-plugin-react is loaded ONLY
  // for jsx-uses-vars/jsx-uses-react so components referenced from JSX
  // don't false-positive as unused; no other react rules. NO `process`
  // global here: this SPA reads config via import.meta.env, so an unguarded
  // `process.env.X` is a real browser crash and must trip no-undef.
  {
    files: ['client/src/**/*.{js,jsx}'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      ...SOURCE_RULES,
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },
  // The one legacy file using the browser-safe guarded pattern
  // `typeof process !== 'undefined' && process.env?...` — scoped exception
  // so the guard keeps passing without hiding unguarded `process` reads
  // elsewhere in client/src.
  {
    files: ['client/src/components/brand/SerifHeading.jsx'],
    languageOptions: {
      globals: { process: 'readonly' },
    },
  },
  // Service worker — registered classic (no `{ type: 'module' }`), so parse
  // as a script: accidental import/export fails lint exactly like it would
  // fail the browser. Worker globals only — no window/document.
  {
    files: ['client/public/sw.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
    rules: SOURCE_RULES,
  },
  // Page-side public scripts (push helper) — ESM in the browser. No worker
  // globals, so `clients`/`importScripts` can't slip into page code.
  {
    files: ['client/public/**/*.js'],
    ignores: ['client/public/sw.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: SOURCE_RULES,
  },
  // Video workspace Node entries — package "type": "module", so .js and
  // .mjs are both ESM. nodeBuiltin only: `require`/`module.exports`/
  // `__dirname` don't exist in ESM and must trip no-undef.
  {
    files: ['video/**/*.{js,mjs}'],
    ignores: ['video/src/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.nodeBuiltin },
    },
    rules: SOURCE_RULES,
  },
  // Remotion compositions — rendered in headless Chrome.
  {
    files: ['video/src/**/*.{js,jsx}'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      ...SOURCE_RULES,
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },
  // Client build configs (vite/postcss/tailwind) — Node-run ESM (client
  // package.json is "type": "module"); nodeBuiltin for the same reason as
  // the video entries.
  {
    files: ['client/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.nodeBuiltin },
    },
    rules: ERRORS_ONLY,
  },
  // A future client/*.cjs really is CommonJS regardless of package type.
  {
    files: ['client/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: ERRORS_ONLY,
  },
  // Client tests — vitest WITHOUT runner globals (vite.config has no
  // `globals: true`; tests import describe/it/expect/vi from 'vitest').
  // No jest/vitest globals whitelisted, so a test that forgets its imports
  // or reaches for `jest.fn()` trips no-undef instead of failing at runtime.
  {
    files: ['client/src/**/*.test.{js,jsx}', 'client/src/test-setup.js', 'client/src/**/__fixtures__/**/*.{js,jsx}'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.nodeBuiltin },
    },
    rules: {
      ...ERRORS_ONLY,
      complexity: 'off',
      'max-depth': 'off',
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },
];

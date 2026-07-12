// Errors-only lint for staged files (wired via lint-staged in the
// scripts/hooks/pre-commit hook). Deliberately NOT a style linter: rules
// here catch code that is broken (undefined identifiers, duplicate keys,
// unreachable code), never how it looks. The repo has no lint history, so
// enforcement is changed-files-only — untouched legacy code is never
// flagged. Escape hatch: git commit -n
const globals = require('globals');
const react = require('eslint-plugin-react');

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
  // Server, scripts, ops, packages — CommonJS on Node.
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'ops/**/*.js', 'packages/**/*.js', 'video/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: ERRORS_ONLY,
  },
  // Jest tests (server + packages).
  {
    files: ['**/*.test.js', '**/tests/**/*.js', '**/contract-tests/**/*.js', '**/__mocks__/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
    rules: ERRORS_ONLY,
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
      ...ERRORS_ONLY,
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
    rules: ERRORS_ONLY,
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
    rules: ERRORS_ONLY,
  },
  // Video workspace ESM entry — render.mjs runs on Node.
  {
    files: ['video/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: ERRORS_ONLY,
  },
  // Remotion compositions — JSX rendered in headless Chrome.
  {
    files: ['video/src/**/*.jsx'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      ...ERRORS_ONLY,
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },
  // Client build configs (vite/postcss/tailwind) — Node-run, ESM syntax.
  {
    files: ['client/*.{js,cjs,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: ERRORS_ONLY,
  },
  // Client tests — vitest WITHOUT runner globals (vite.config has no
  // `globals: true`; tests import describe/it/expect/vi from 'vitest').
  // No jest/vitest globals whitelisted, so a test that forgets its imports
  // or reaches for `jest.fn()` trips no-undef instead of failing at runtime.
  {
    files: ['client/src/**/*.test.{js,jsx}', 'client/src/test-setup.js'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...ERRORS_ONLY,
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },
];

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
  // don't false-positive as unused; no other react rules.
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
  // Client tests (vitest via explicit imports + jsdom).
  {
    files: ['client/src/**/*.test.{js,jsx}', 'client/vitest.setup.js'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node, ...globals.jest },
    },
    rules: {
      ...ERRORS_ONLY,
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },
];

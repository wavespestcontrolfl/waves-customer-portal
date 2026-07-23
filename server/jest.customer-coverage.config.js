/**
 * Customer-backend coverage gate.
 *
 * The main server suite spans staff, marketing, SEO, dispatch, and other
 * products outside this audit. This deliberately measures the customer-app
 * security and business-logic modules that have direct executable tests.
 * Route files that currently depend on broad module mocks are excluded until
 * HTTP contract tests can cover them honestly; imposing their present ~20%
 * result would create a low-value gate rather than useful protection.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/tests/auth-token.test.js',
    '<rootDir>/tests/auth-logout-route.test.js',
    '<rootDir>/tests/customer-auth-resolve-bearer.test.js',
    '<rootDir>/tests/customer-refresh-session.test.js',
    '<rootDir>/tests/autopay-eligibility.test.js',
    '<rootDir>/tests/portal-ach-add-bank.test.js',
    '<rootDir>/tests/customer-pricing-ai.test.js',
    '<rootDir>/tests/customer-pricing-ai-variants.test.js',
    '<rootDir>/tests/customer-request-photo-validation.test.js',
    '<rootDir>/tests/customer-notification-native-push.test.js',
    '<rootDir>/tests/customer-notification-push.test.js',
  ],
  collectCoverage: true,
  collectCoverageFrom: [
    '<rootDir>/middleware/auth.js',
    '<rootDir>/services/autopay-eligibility.js',
    '<rootDir>/services/customer-pricing-ai.js',
    '<rootDir>/services/notification-service.js',
    '<rootDir>/utils/request-photo-validation.js',
  ],
  coverageReporters: ['text', 'json-summary'],
  // Measured 2026-07-16 baseline: 77.06 statements, 69.50 branches,
  // 84.61 functions, 81.14 lines. Rounded floors protect the baseline while
  // allowing small source-map/instrumentation differences across Node 20.
  coverageThreshold: {
    global: {
      statements: 75,
      branches: 65,
      functions: 80,
      lines: 80,
    },
  },
};

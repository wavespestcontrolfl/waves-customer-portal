// Shared corpus of prohibited product-claim wordings (blanket safety,
// EPA approval, fixed re-entry / drying times).
//
// Two suites consume it:
//   - content-guardrails.test.js asserts the shared reentrySafetyClaimFinding
//     flags every entry;
//   - ask-waves-intake.test.js asserts the Ask Waves intake chokepoint (kept
//     separate because the shared checker is too slow per chat turn, #4905)
//     flags every entry too.
// When you teach the shared rules a new wording, add it here — the intake
// chokepoint is then held to it automatically.
module.exports.FLAGGED_CLAIMS = [
  'Our treatment is completely safe for pets.',
  'The product is EPA-approved.',
  'You can re-enter after 30 minutes.',
  'The treatment dries in 20 minutes.',
  'Our pet-safe formula.',
  'Pet-Safe treatment for your yard.',
  'EPA approved products.',
  'Safe for pets and kids once dry.',
  'Re-entry after 2 hours.',
  'Allow 30 minutes to dry before re-entry.',
  'Keep pets off the lawn for 1 hour.',
  'Kid-safe and pet-safe.',
  'Stay off treated areas for 4 hours.',
  'This product is safe around children.',
];

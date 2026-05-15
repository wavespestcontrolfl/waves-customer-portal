# AGENTS.md

## Project
This is the WAVES Pest Control pricing engine. It produces sales estimates for pest, lawn, termite, mosquito, rodent, and related services.

## Rules
- Preserve the public API unless explicitly asked to change it.
- The main export must remain stable for active pricing entry points.
- Make small, reviewable changes.
- Do not rewrite unrelated services.
- Do not change pricing tables unless the task specifically says to.
- When changing pricing behavior, add or update tests.
- Prefer pure helper functions for pricing logic.
- Return explanatory metadata when a price is estimated, capped, extrapolated, or field verification is needed.
- Use clear names: measured, estimated, confidence, basis, selected, recommended, costFloorApplied.
- Backward compatibility matters. Legacy input fields should continue to work unless explicitly deprecated.

## Lawn Pricing Principles
- St. Augustine is a single grass type.
- Legacy St. Augustine Shade input should map to St. Augustine.
- Turf square footage is the primary lawn pricing input.
- Measured turf area beats estimated turf area.
- Lot-based turf estimates are low confidence and should require field verification.
- The market price table is the default price source.
- Optional cost-floor pricing may raise prices but should be disabled by default.
- Large lawns above the table maximum must never be silently clamped without a custom quote flag.

## Testing
Before finishing, run the available tests. If no test framework exists, add a minimal Node-based test script for the modified logic.

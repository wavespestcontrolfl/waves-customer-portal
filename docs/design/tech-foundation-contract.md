# Tech foundation scope

The owner-approved September 7 design-system audit and September 8 continuation define this Tech proof: share primitive behavior and accessibility where practical, retain deliberate surface tokens and touch density, and keep the Today / Visit / Complete workflow separate from the admin record layout.

This is a deliberate migration of the recap and photo compositions, not a rule for unrelated legacy Tech files:

- Reuse `components/ui` field association, pending actions, feedback, choice behavior and explicit touch density.
- Keep Tech palette, typography, safe areas and workflow layout in named `tech-visit-*` surface classes.
- Remove the migrated component's page-local palette rather than mixing a `D` object with UI primitives.
- Preserve the existing API, authorization, actual-treatment, notification and draft owners.
- Require 48px targets and 16px field text in the migrated forms, with desktop and touch-WebKit verification.
- Keep the Intelligence Bar on its existing presentation pending its separately scoped UX pass.

The shared primitive review and Tech route proof must run together when shared behavior changes. This bounded reuse does not apply admin color, compact sizing, uppercase defaults or a record-page layout to Tech. Photos remain selected in memory while their dialog is open; this scope does not define an offline upload queue or recovery across route navigation.

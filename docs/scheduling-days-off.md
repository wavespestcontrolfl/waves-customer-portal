# Days off and closed days

How the scheduler knows Waves, or one technician, is not working on a date. Read this
before you change what any booking path, the recurring seeder or auto-dispatch offers.

Owner ruling 2026-11-24: Waves is closed on six holidays and every technician gets their
own birthday off. Sundays and every other holiday are work days.

## The layers

Two kinds of closure exist. A **business closure** stops every technician. A **technician
closure** stops one technician and leaves the others working.

| Layer | Kind | Where it lives | Who changes it |
| --- | --- | --- | --- |
| One-off blackout dates | business | table `schedule_blackout_dates` | Office: Settings, Scheduling, Blackouts |
| Weekly days off | business | `system_settings` key `schedule_weekly_days_off` (JSON array of 0 to 6, 0 = Sunday) | Office: Settings, Scheduling, Blackouts |
| Yearly holiday closures | business | `system_settings` key `schedule_holiday_closures` (JSON array of holiday keys) | Office: Settings, Scheduling, Blackouts |
| Technician birthday | technician | owner policy; enforcement through `technician_absences` rows is a separate change | Office: date of birth on the technician's payroll profile |
| Technician out | technician | table `technician_absences` (an uncleared row) | Office: the tech-out flow |

### One-off blackout dates and weekly days off

A one-off date closes that calendar day for everyone. Weekly days off close every matching
weekday. Waves works Sundays, so `schedule_weekly_days_off` is empty. Do not add Sunday to it.
With `GATE_AUTO_DISPATCH_DAY_RULES` on, auto-dispatch already ranks a Sunday slot after every
Monday to Saturday slot.

### Yearly holiday closures (`server/services/scheduling/holidays.js`)

The file knows 14 holidays by key, each from a yearly rule, so nobody types next year's
dates. A key in `schedule_holiday_closures` closes that holiday every year. A missing or
empty list means every holiday is open. That default stays in code.

The owner closed the **Big 6** on 2026-11-24. The setting is written in production, not in code:

| Key | Holiday |
| --- | --- |
| `new_years_day` | New Year's Day |
| `memorial_day` | Memorial Day |
| `independence_day` | 4th of July |
| `labor_day` | Labor Day |
| `thanksgiving` | Thanksgiving |
| `christmas` | Christmas |

A fixed-date holiday (New Year's Day, 4th of July, Christmas) on a weekend also closes the
observed weekday: Saturday closes the Friday before, Sunday closes the Monday after. Christmas
2027 is a Saturday, so Friday 2027-12-24 is closed too. The customer-facing line says this. Every other holiday in the file stays open:
Black Friday, Christmas Eve, New Year's Eve, Martin Luther King Jr. Day, Presidents' Day,
Easter and the rest are normal work days.

### Technician birthday (owner policy)

Owner policy 2026-11-24 (benefits ruling E6, 2026-11-20): each technician gets their own
birthday off, one paid day. The date of birth lives in `technicians.dob` (Time Tracking, Team,
Edit Technician, Payroll & personal info, Date of birth).

The scheduler does **not** enforce this yet. Enforcement is coming in a separate change that
writes a birthday as an ordinary `technician_absences` row, so every reader in the table
below, the dispatch board and the locked rechecks treat it exactly like a technician out.
Until that ships, the office keeps a technician's birthday clear by hand (the tech-out flow).

### Technician out (`technician_absences`)

An uncleared row marks one technician out for one date. The tech-out flow
(`tech-out.js`, `tech-out-auto-move.js`) also parks and moves the visits the technician
already held.

## Who reads each layer

Business closures go through `server/services/scheduling/blackout-dates.js`
(`isBlackoutDate`, `getBlackoutDates`, `getBlackoutLayers`). Customer-facing readers fail
open: an unreadable list reads as "open" so an outage never blocks booking. The
auto-dispatch readers pass `{ strict: true }`, so an unreadable list stops a move instead.

| Reader | Business closures | Technician closures (technician out) |
| --- | --- | --- |
| Find a time and booking (`scheduling/find-time.js`, the `/book` page, reschedule, estimate slots, AI searches) | Skips the date | `absentTechDays` skips the technician on that date. If every technician is out, no slot. |
| Slot hold and confirm (`slot-reservation.js`, `routes/booking.js /confirm`) | Re-checked at redemption, so an offer minted before a closure cannot be booked | `assertAssignableTechnician` with the date refuses the technician |
| Recurring seeder (`recurring-appointment-seeder.js`) | Nudges a child visit off a closed day | A child on a day its technician is out is seeded with no technician. The office or auto-dispatch places it. |
| Office assignment (`dispatch-assignment.js`, board drag, `admin-dispatch.js /technicians?date=`) | Not applicable | Refused with a 422. The picker does not offer the technician for that date. |
| Series children (`admin-schedule.js assignableRecurringTemplateTechnicianId`) | Not applicable | The child is created with no technician |
| Auto-dispatch candidate slots (`auto-dispatch/candidate-slots.js`, via find-time) and `scheduling/pick-technician.js` | Skips the date | Skips the technician on that date |
| Ads capacity, route check, open-blocks alert, annual prepay series | Not applicable | Count the technician as away |

### Auto-dispatch and a closed day

With `GATE_AUTO_DISPATCH_CONFLICT_MOVES` on, a visit that sits on a business closure is a
`closed_day` conflict (`auto-dispatch/current-conflict.js`). It moves to the nearest legal
slot, even when the move saves little drive. A conflict move does **not** skip these
guards, which still apply:

- a customer-confirmed visit stays,
- a visit a person placed stays,
- a visit inside 73 hours (the reminder freeze) stays.

A visit that stays on a closed day raises a needs-a-person notice. The nightly path reads
the closed days with `strict`, so an unreadable list stops the move.

## How the office changes things

- **A closed day, a weekly day off or a holiday:** Settings, Scheduling, Blackouts
  (`/admin/settings?tab=blackout-days`). Holiday switches are there too. Adding a closure
  takes the closure-state lock, so a hold in flight cannot slip onto the new closed day.
- **A technician birthday:** set the date of birth on the technician's payroll profile (Time
  Tracking, Team, Edit Technician, Show Payroll & personal info). Scheduling does not read it yet.
- **A technician out:** the tech-out flow on the dispatch board.

## Tests

- `server/tests/schedule-holidays.test.js`: the 14 yearly rules and the observed-weekday rule.
- `server/tests/technician-eligibility.test.js`: absences and work days through the shared seam.
- `server/tests/sms-company-facts.test.js`: the customer-facing line about closed days.

The texting agent, the phone agent and the portal chat all read the same company-facts line
(`server/services/sms-company-facts.js`, line 6). Change the owner's closed days there too.

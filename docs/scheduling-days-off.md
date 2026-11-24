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
weekday. Owner 2026-11-24: Sundays are work days, so Sunday is not a weekly day off.

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
2027 is a Saturday, so Friday 2027-12-24 is closed too. The agents' line says this. Every other holiday in the file stays open:
Black Friday, Christmas Eve, New Year's Eve, Martin Luther King Jr. Day, Presidents' Day,
Easter and the rest stay open unless the owner closes them.

### Technician birthday (owner policy)

Owner policy 2026-11-24 (benefits ruling E6, 2026-11-20): each technician gets their own
birthday off, one paid day. The date of birth lives in `technicians.dob` (Time Tracking, Team,
Edit Technician, Payroll & personal info, Date of birth).

The scheduler does **not** enforce this yet. Enforcement is coming in a separate change that
writes a birthday as an ordinary `technician_absences` row, so every reader in the table
below, the dispatch board and the locked rechecks treat it exactly like a technician out.
Until that ships, the office keeps a technician's birthday clear by hand (the tech-out flow).

### Technician out (`technician_absences`)

An uncleared row marks one technician out for one date. The tech-out flow (`tech-out.js`)
also parks the technician's open stops on that day as alerts.

## Who reads each layer

Business closures are read through `server/services/scheduling/blackout-dates.js`
(`isBlackoutDate`, `getBlackoutDates`, `getBlackoutLayers`). By default a failed read returns "open"
(`{ strict: true }` makes it throw instead). Technician closures are read through
`absentTechDays` and `assertAssignableTechnician` in `server/services/technician-eligibility.js`.

| Reader | Business closures | Technician out |
| --- | --- | --- |
| Offer search (`scheduling/find-time.js`) and estimate slots (`estimate-slot-availability.js`) | Skips the date | `absentTechDays` skips the technician on that date |
| Recurring seeder (`recurring-appointment-seeder.js`) | Nudges a child visit off a closed day | A child on a day its technician is out is seeded with no technician |
| Series children (`admin-schedule.js assignableRecurringTemplateTechnicianId`) | Not read | The child is created with no technician |
| Office assignment (`dispatch-assignment.js`) and the picker (`admin-dispatch.js GET /technicians?date=`) | Not read | The save is refused (422); the picker does not list the technician |
| Auto-dispatch candidate slots (`auto-dispatch/candidate-slots.js`, through `findAvailableSlots`) | Skips the date | Skips the technician on that date |
| Fixed-time technician picker (`scheduling/pick-technician.js`) | **Not read.** It measures drive detours with `includeBlackoutDates: true` and does not check business closures itself. | Skips the technician on that date |
| Day re-plan route check (`day-replan/route-check.js`) and open-blocks alert (`day-replan/open-blocks-alert.js`) | `getBlackoutDates(..., { strict: true })`: closed dates are excluded, and an unreadable list throws | Counts the technician as away |
| Annual prepay series seeding (`annual-prepay-series-slot.js`) | Not read | The technician is dropped on that date |

### The closure-state lock

The shared closure-state lock is `lockClosureState` in `blackout-dates.js`.

- **Exclusive (the four writers in `routes/admin-schedule.js`):** `PUT /blackout-dates/weekly`,
  `PUT /blackout-dates/holidays`, `POST /blackout-dates` and `DELETE /blackout-dates/:id`.
- **Shared, then a fresh read of the closed days:**
  - the capacity-mode commit check, `assertCapacityEligibility` in `scheduling/arrival-route.js`
    (reached through `verifyArrivalCapacity`, which runs only with capacity mode on or `preserveCapacity`);
  - `rescheduleSeries` in `rebooker.js` (`assertClosedDaysUnchanged`);
  - auto-dispatch `apply.js` (`fenceSourceConflict`), for a `closed_day` source conflict.
- **A date re-check only, no closure lock:**
  - `createSelfBooking` in `routes/booking.js` calls `isBlackoutDate` before its write transaction opens;
  - `reserveSlot`, `commitReservation` and `extendReservation` in `slot-reservation.js` call
    `isBlackoutDate`. `commitReservation` and `extendReservation` read on their own transaction.

So a closure saved at the same moment as one of the second group is serialized with it. A path in the
third group can still commit in the gap between its date check and its write.

### Auto-dispatch and a closed day

With `GATE_AUTO_DISPATCH_CONFLICT_MOVES` on, `auto-dispatch/current-conflict.js` reports a `closed_day`
conflict when `isBlackoutDate(date, db, { strict: true })` is true for a visit that has an arrival window.
A read failure throws, so the visit is not evaluated. The conflict only lifts the score bar and the drive
floor for that visit (`move-rules.js`). Every other guard still applies, among them:

- eligibility: a recurring child visit, not locked or excluded by staff, an active customer
  (`auto-dispatch/eligibility.js`);
- the day lock for the active mode (route tiers, flex tier, or the flat lock window);
- the reminder freeze: 24.25 hours in route-tier mode, 25 hours in flex mode (`auto-dispatch/index.js`
  `reminderFreezeHours`);
- the fixed-visit rule (`eligibility.js`, owner 2026-11-22): the customer asked for this time, the
  customer placed the visit, or staff locked it.

A staff placement and a customer confirmation alone do not hold a visit any more (owner 2026-11-22).
A visit that cannot move stays on the closed day. `auto-dispatch/needs-person-notice.js` can name it
("is on a closed day").

## How the office changes things

- **A closed day, a weekly day off or a holiday:** the Blackouts tab, `/admin/settings?tab=blackout-days`.
- **A technician birthday:** set the date of birth on the technician's payroll profile (Time
  Tracking, Team, Edit Technician, Show Payroll & personal info). Scheduling does not read it yet.
- **A technician out:** the tech-out flow on the dispatch board.

### The agents' holiday line

The texting, voice and chat agents carry one static line naming the six closed holidays and saying
"We work Sundays" (`COMPANY_FACTS[6]` in `server/services/sms-company-facts.js`, keys in
`FACT_CLOSED_HOLIDAY_KEYS`). The line is static: the voice agent renders it when its module loads and
the sealed exam pins the render by hash, so it does not follow Settings.

Nothing in the portal compares the line with Settings. `factsLineMatchesSettings({ closedHolidays, weeklyDaysOff })`
in the same file is the pure check: true when the closed holidays are exactly `FACT_CLOSED_HOLIDAY_KEYS` and
Sunday is not a weekly day off. A daily read-only ops check outside the portal compares the live settings with it
and raises one self-closing admin bell when they differ. Changing the closed days takes a code edit to the line
and to `FACT_CLOSED_HOLIDAY_KEYS` together.

## Tests

- `server/tests/schedule-holidays.test.js`: the 14 yearly rules and the observed-weekday rule.
- `server/tests/technician-eligibility.test.js`: absences and work days through the shared seam.
- `server/tests/sms-company-facts.test.js`: the closed-days line, and that it names exactly `FACT_CLOSED_HOLIDAY_KEYS`.

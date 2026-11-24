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
writes a birthday as an ordinary `technician_absences` row, so every reader of a technician
out treats it the same way.
Until that ships, the office keeps a technician's birthday clear by hand (the tech-out flow).

### Technician out (`technician_absences`)

An uncleared row marks one technician out for one date. The tech-out flow (`tech-out.js`)
also parks the technician's open stops on that day as alerts.

## Where the code reads them

- Business closures: `server/services/scheduling/blackout-dates.js` (`isBlackoutDate`, `getBlackoutDates`,
  `getBlackoutLayers`). Each helper's header states how it handles a failed read; callers choose their own fallback.
- Technician out: `absentTechDays` and `assertAssignableTechnician` in `server/services/technician-eligibility.js`.
- Auto-dispatch: with `GATE_AUTO_DISPATCH_CONFLICT_MOVES` on, `auto-dispatch/current-conflict.js` marks a visit
  on a closed day as a `closed_day` conflict and tries to move it. Its usual guards still apply
  (`auto-dispatch/eligibility.js`, the day lock and the reminder freeze in `auto-dispatch/index.js`). A visit that
  cannot move stays, and `auto-dispatch/needs-person-notice.js` can name it.

Read those files before you change a booking path, the recurring seeder or auto-dispatch. This page does not
restate their behavior, so the code stays the one source.

## How the office changes things

- **A closed day, a weekly day off or a holiday:** the Blackouts tab, `/admin/settings?tab=blackout-days`.
- **A technician birthday:** set the date of birth on the technician's payroll profile (Time
  Tracking, Team, Edit Technician, Show Payroll & personal info). Scheduling does not read it yet.
- **A technician out:** the tech-out flow on the dispatch board.

### The agents' holiday line

The texting, voice and chat agents carry one static line naming the six closed holidays and saying
"We work Sundays and all other holidays" (`COMPANY_FACTS[6]` in `server/services/sms-company-facts.js`, keys in
`FACT_CLOSED_HOLIDAY_KEYS`). The line is static: the voice agent renders it when its module loads and
the sealed exam pins the render by hash, so it does not follow Settings.

Nothing in the portal compares the line with Settings. `factsLineMatchesSettings({ closedHolidays, weeklyDaysOff })`
in the same file is the pure check: true when the closed holidays are exactly `FACT_CLOSED_HOLIDAY_KEYS` and
no weekday at all is a weekly day off. Any weekly day off is a mismatch: a Friday off, for example, closes Good Friday
and Black Friday, and the line says Waves works every holiday it does not name. A daily read-only ops check outside the portal compares the live settings with it
and raises one self-closing admin bell when they differ. Changing the closed days takes a code edit to the line
and to `FACT_CLOSED_HOLIDAY_KEYS` together.

## Tests

- `server/tests/schedule-holidays.test.js`: the 14 yearly rules and the observed-weekday rule.
- `server/tests/sms-company-facts.test.js`: the closed-days line, and that it names exactly `FACT_CLOSED_HOLIDAY_KEYS`.

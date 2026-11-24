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
| Technician birthday | technician | `technician_absences` rows with source `tech_days_off`, written from `technicians.dob` by the daily `tech-days-off` job | Office: date of birth on the technician's payroll profile |
| Technician holiday taken day | technician | the same rows, written from `technicians.work_days` and the closed holidays | Office: work days on the Team tab, closed holidays in Blackouts |
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

The scheduler enforces it. The daily job `syncTechDaysOff` (`server/services/tech-birthday-absences.js`,
03:25 ET, cron lock `tech-days-off`) writes one `technician_absences` row for each active,
field-dispatchable technician with a date of birth, for each birthday in the next 120 days. A Feb 29
birthday falls on Feb 28 in a common year. The row has reason `other` and source `tech_days_off`.
Every reader of a technician out then honors it. The job also clears its own future rows when the
date is no longer wanted (the technician left, or the date of birth changed). An office row on the
same day always wins, and a row the office clears is never written again. The job writes no pay: the
office adds the paid day in Payroll.

### Technician holiday taken day (owner ruling 2026-11-24)

Technicians work four 10-hour days, Monday to Thursday. Waves closes the six holidays above, but a
technician is not off on a closed holiday that lands on a day they do not work. They take the
holiday on a work day instead (Employee Handbook, Holidays). The same daily job writes that day as
a `technician_absences` row (reason `other`, source `tech_days_off`), so a technician's birthdays
and holiday taken days are one set of rows, and a date that is both is one row.

The rule applies only to a technician whose `technicians.work_days` is set (0 = Sunday). NULL
`work_days` gives no holiday row. For each closed holiday the job reads the holiday's own calendar
date, not the observed weekday:

| Holiday on | Technician works that day | Taken day |
| --- | --- | --- |
| Monday to Saturday | yes | none: the business closure covers it |
| Monday to Saturday | no | the nearest earlier work day in the same Monday to Sunday week; none if there is none |
| Sunday | no | the first work day after it |

A taken day that Waves is itself closed on gets no row. Examples for a Monday to Thursday technician:
Christmas 2026 (Friday) gives Thursday 2026-12-24, New Year's Day 2027 (Friday) gives Thursday
2026-12-31, Thanksgiving (Thursday) gives nothing, and July 4 2027 (Sunday) gives nothing because
Monday 2027-07-05 is the observed closed day. The closed days come through
`scheduling/blackout-dates.js` (`getClosedHolidays` and `getBlackoutDates`, strict reads), never a copy.

A holiday row clears (a system clear, as for a birthday) when Settings reopens that holiday, when the
technician's `work_days` changes, or when the technician leaves. The job recomputes the wanted set under
the tech-day lock before it clears. A holiday-only row is also rechecked under the tech-day lock and the shared closure-state lock before it is written, so a holiday the office reopens between the pass's read and the write writes nothing. If the closure settings cannot be read, or the stored closure list is not a JSON array (a strict read of `schedule_holiday_closures` throws on it; the default fail-open read is unchanged), the job writes no holiday
row and clears none in that pass, and counts the read as a failure so the cron health shows it.
Birthdays still run. The job reads the settings only when some technician has `work_days`. No gate
covers it: it sends nothing, charges nothing, writes no pay and deletes nothing. The owner's only active
technician has NULL `work_days` today, so the rule has no live effect until a technician gets a work-days list.

### Technician out (`technician_absences`)

An uncleared row marks one technician out for one date. The tech-out flow (`tech-out.js`)
also parks the technician's open stops on that day as alerts.

## Where the code reads them

- Business closures: `server/services/scheduling/blackout-dates.js` (`isBlackoutDate`, `getBlackoutDates`,
  `getBlackoutLayers`). Each helper's header states how it handles a failed read; callers choose their own fallback.
- Technician birthdays and holiday taken days: `syncTechDaysOff` in `server/services/tech-birthday-absences.js`.
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
  Tracking, Team, Edit Technician, Show Payroll & personal info). The next 03:25 ET run writes the day.
- **A technician's holiday taken days:** set the technician's work days on the Team tab (Work days).
  Holidays closed in Blackouts then give the day before off. To undo one day, clear the row in the tech-out flow.
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
- `server/tests/tech-birthday-absences.test.js` and `tech-birthday-absences-postgres.test.js`: birthdays, holiday taken days, reconcile.
- `server/tests/sms-company-facts.test.js`: the closed-days line, and that it names exactly `FACT_CLOSED_HOLIDAY_KEYS`.

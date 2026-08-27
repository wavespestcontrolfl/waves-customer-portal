# Technician Provisioning Runbook

How to create, hand off, and (if needed) deactivate a field-technician
account.

**Two creation paths exist — order matters.** The Time Tracking Team tab's
"+ Add Technician" creates a *profile only* (name/phone/email/payroll — no
password, no login). Credential provisioning is the register API call
below. **Register FIRST** for a login-capable hire: register creates the
full account, and the Team tab then shows it for payroll fields. If a
profile row was already created for the hire's email, register returns 409
— don't fight it: have the hire use "Forgot password" on the login page
with that email instead (it sets their first password via the emailed reset
link), and add licensing via the compliance surface.

## Before you start

- You need an **admin session token** (log into the admin portal, or use the
  login endpoint). Registration is `requireAdmin`.
- Pick a **temporary password** that satisfies the staff policy: at least 12
  characters with three of {lowercase, uppercase, number, symbol}. It only
  needs to survive one login — the account is created with
  `must_change_password` armed, so the hire is forced to set their own
  password before anything else works.
- Have the hire's **FDACS applicator license number and expiry** if they are
  already licensed. Passing them at registration is what arms the daily
  license-expiry watch (it reads `technicians.license_expiry`); nothing else
  in the product backfills these fields. If the hire is not yet licensed,
  omit them and add them once the ID card is issued.

## Create the account

```bash
curl -sS -X POST https://portal.wavespestcontrol.com/api/admin/auth/register \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "First Last",
    "email": "tech@wavespestcontrol.com",
    "password": "<temporary password>",
    "role": "technician",
    "fl_applicator_license": "JF000000",
    "license_expiry": "2027-06-30"
  }'
```

- `role` accepts only `technician` or `admin` (defaults to `technician`).
- `fl_applicator_license` (≤50 chars) and `license_expiry` (`YYYY-MM-DD`)
  are optional; malformed values are a 400 and nothing is created.
- 409 means the email is already in use (canonical, case-insensitive match).
- The 201 response echoes `mustChangePassword: true` — confirm it before
  handing off.

## Hand off

**The registered email must be a real mailbox the hire can open at
handoff** — the forced password change on the admin login surface is
completed through an emailed reset link.

1. Give the hire the email + temporary password **out-of-band** (in person
   or by voice — not SMS/email that persists next to the address).
2. First login forces them to set their own password before anything else
   works (the middleware 403s every API call until they do). Both entry
   points lead to the same flow: `/tech` bounces unauthenticated visitors
   to the shared `/admin/login`, and logging in there with the temporary
   password discards the session and routes to the reset screen, which
   emails a reset link to their registered address. They set their own
   password from that link and log in again. This is the deliberate
   forced-reset flow — do not hand-edit it.
3. Have them open the tech portal at `/tech` and add it to their home screen
   (the install hint shows on first visit). Push notifications are opt-in
   from the portal once logged in.

## What the account can do

The technician role activates the role-lockdown boundaries shipped in
PR #3501: day-to-day surfaces (schedule, dispatch, customers, projects,
knowledge/protocols, equipment, inventory stock ops, communications,
time tracking) work; owner surfaces (pricing, revenue, invoices, marketing,
settings config, estimates pipeline) are hidden and deny deep links.
Technicians land on `/admin/schedule`; the field app is `/tech`.

## Deactivate / offboard

Use the existing deactivation endpoint — never a direct DB update, which
would skip credential revocation:

```bash
curl -sS -X DELETE \
  https://portal.wavespestcontrol.com/api/admin/timetracking/technicians/<id> \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

It runs the full offboard atomically: refuses if the tech has an active
timer or is the final admin, sets `active = false`, bumps
`auth_token_version` (revoking every issued JWT), clears pending
password-reset tokens, deactivates push subscriptions, and disconnects
sockets. The staff row is never deleted — visits, time entries, payroll,
and reports reference the technician id.

## Related

- Register handler: `server/routes/admin-auth.js` (`_handlers.register`).
- Forced-change enforcement: `server/middleware/admin-auth.js`.
- License-expiry watch: `~/waves-ops/ops-crons/checks/f31-tech-licenses.js`
  (alerts at expired/7/30/60 days for active technicians).

# Customer iOS unread badges — app-side sync

`GATE_CUSTOMER_NATIVE_BADGES` is opt-in everywhere. The existing authenticated
`/api/customer-notifications/unread-count` response retains `count` and adds
`nativeBadgeEnabled`. It uses the existing selected-customer inbox scope, not
an account-wide sum or an admin count. No new query, table or delivery is added.

With the gate enabled, supported iOS builds mirror confirmed inbox counts on
launch, resume, foreground notification receipt, the existing 30-second poll,
and successful read/read-all. Read failures preserve the last badge. Sign-out
and account/property changes invalidate pending updates and clear the icon.
A confirmed cancelled account also clears it, including on a fresh launch.
Routine access-token rotation does not clear it. Disabling the gate clears the
badge after the next successful count read; offline clients reconcile on resume.
Older server responses, older binaries, Android and web remain compatible.

The local Capacitor bridge uses Apple's badge API without requesting permission
or storing customer data. `bootstrap-ios.sh` installs the tracked Swift source,
adds it to App's Sources phase and registers it via the main bridge controller.
Existing custom bridge controllers stop setup for deliberate integration.
Reference: [Capacitor local iOS plugins](https://capacitorjs.com/docs/ios/custom-code).

This does **not** add background APNs badge payloads or change push routing.
When the app is closed, a new notification will not change the icon until the
app next syncs. The delivery service is a separate session's active work.

Release requires a new signed binary containing `WavesBadgePlugin`, the web/API
deployment and owner activation of the gate. Do not enable it or deliver test
notifications without the owner's authorization and an owner-controlled target.
On a physical iPhone verify nonzero/zero counts, read/read-all, background/resume,
offline reads, sign-out, property switching and disabled badge permission.
Unit tests and simulator builds do not establish physical-device badge behavior.

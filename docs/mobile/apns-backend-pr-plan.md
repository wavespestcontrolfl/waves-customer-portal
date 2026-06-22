# PR plan — APNs push delivery for the native iOS app

**Goal:** deliver push to the Capacitor iOS app via Apple Push Notification
service (APNs), reusing the existing `push_subscriptions` table and the existing
`sendToCustomer` / `sendToAdmins` call sites. Web push (VAPID) is untouched.

**Scope:** backend only. The client side (token registration) already ships in
the Capacitor spike (`client/src/native/nativePush.js`).

**Principle:** routing by platform happens **inside `sendSubscription`** — every
existing caller (`sendToCustomer`, `sendToAdmins`, `sendToAdminUsers`) keeps
passing the same `{ title, body, url, ... }` object and stays unchanged.

---

## 1. DB migration — `server/models/migrations/<ts>_push_apns.js`

`push_subscriptions` today (migration `20260401000031_pwa_push.js`):
`id, customer_id, admin_user_id, role, subscription_data (text NOT NULL),
device_info, active, created_at`.

Add:

```js
exports.up = async (knex) => {
  await knex.schema.alterTable('push_subscriptions', (t) => {
    t.string('platform', 10).notNullable().defaultTo('web'); // 'web' | 'ios'
    t.text('device_token');                                  // raw APNs hex token (ios)
  });
  // Dedup re-registrations of the same device.
  await knex.schema.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_device_token_uniq
     ON push_subscriptions (device_token) WHERE device_token IS NOT NULL`
  );
};

exports.down = async (knex) => {
  await knex.schema.raw('DROP INDEX IF EXISTS push_subscriptions_device_token_uniq');
  await knex.schema.alterTable('push_subscriptions', (t) => {
    t.dropColumn('platform');
    t.dropColumn('device_token');
  });
};
```

Note: `subscription_data` is `NOT NULL`. For iOS rows we don't change that
constraint — we write `subscription_data = JSON.stringify({ token })` (satisfies
NOT NULL) **and** mirror the token into the queryable `device_token` column.
Existing web rows default to `platform='web'` — no backfill needed.

> Migrations run on Railway **deploy**, not at merge.

## 2. APNs sender — `server/services/apns.js` (new)

Token-based (.p8) APNs over HTTP/2. Avoid the unmaintained `node-apn`; use Node's
built-in `http2` + `jsonwebtoken` (ES256) — `jsonwebtoken` is already in the tree
for session auth. (`@parse/node-apn` is the batteries-included alternative if we'd
rather not hand-roll the HTTP/2 client.)

```
makeProviderToken()  → ES256 JWT { iss: TEAM_ID, iat }, header { alg:'ES256', kid: KEY_ID }
                       signed with APNS_KEY (.p8). Cache < 1h (Apple rejects > 1h, 429s if < 20min churn).
send(deviceToken, notification):
   POST https://api.push.apple.com/3/device/<token>        (prod)
        https://api.sandbox.push.apple.com/3/device/<token> (dev, APNS_PRODUCTION!=='true')
   headers: authorization: bearer <jwt>, apns-topic: APNS_BUNDLE_ID, apns-push-type: alert
   body: { aps: { alert: { title, body }, sound: 'default', badge }, url, ...data }
   → 200 ok
   → 410 (Unregistered) or 400 BadDeviceToken → return { expired:true } so the
     caller deactivates the row (mirrors the web-push 410/404 handling).
status() → { configured: boolean } for PushNotificationService.status()
```

Configuration is read once at module load (mirror the VAPID block in
`push-notifications.js`): trim env, log configured/not-configured, fail soft.

## 3. Route in `push-notifications.js` `sendSubscription`

Branch at the top of the existing function — everything else stays:

```js
async function sendSubscription(sub, notification) {
  if (sub.platform === 'ios') {
    const apns = require('./apns');
    if (!apns.status().configured) return { sent: false, skipped: true, reason: 'apns_not_configured' };
    const r = await apns.send(sub.device_token, notification);
    if (r.expired) {
      await db('push_subscriptions').where({ id: sub.id }).update({ active: false });
      return { sent: false, expired: true, reason: 'token_unregistered' };
    }
    return r.ok ? { sent: true } : { sent: false, failed: true, reason: r.reason };
  }
  // ---- existing web-push path unchanged ----
}
```

`sendToCustomer` / `sendToAdmins` / `sendToAdminUsers` need **no change** — they
already select all active rows for the target and call `sendSubscription` per row.
`status()` should also surface `apns: require('./apns').status()`.

## 4. Native subscribe endpoint

`nativePush.js` POSTs `{ platform:'ios', token, deviceInfo }` to
`/api/push/native-subscribe`. Add it where the identity middleware is already
applied so it attaches to the logged-in user:

- **customer session** → `customer_id`, `role:'customer'`
- **tech/admin session** → `admin_user_id`, `role` (mirror `admin-push.js:52`)

Upsert by `device_token` (the unique index) so re-launch re-registration is
idempotent:

```js
// pseudocode
const row = {
  platform: 'ios',
  device_token: token,
  subscription_data: JSON.stringify({ token }), // satisfies NOT NULL
  device_info: deviceInfo || 'iOS',
  active: true,
  ...(customerId ? { customer_id: customerId, role: 'customer' }
                 : { admin_user_id: adminUserId, role: techRole }),
};
await db('push_subscriptions')
  .insert(row)
  .onConflict('device_token')
  .merge({ active: true, customer_id: row.customer_id, admin_user_id: row.admin_user_id, role: row.role });
```

Pair it with an unsubscribe / token-rotation path (deactivate by `device_token`),
mirroring `admin-push.js` `/unsubscribe`.

## 5. Config / secrets (Railway env) + Apple setup

New env vars:
- `APNS_KEY` — contents of `AuthKey_XXXXXXXXXX.p8`
- `APNS_KEY_ID` — the key's 10-char ID
- `APNS_TEAM_ID` — Apple Developer Team ID
- `APNS_BUNDLE_ID` — `com.wavespestcontrol.portal`
- `APNS_PRODUCTION` — `'true'` to use the prod APNs host

Apple side (one-time):
- App Store Connect → **Keys** (or Certificates, Identifiers & Profiles) → create
  an **APNs Auth Key** (.p8); one key works for all the org's apps.
- Enable the **Push Notifications** capability on the App ID
  `com.wavespestcontrol.portal`.

## 6. Tests (mirror existing patterns in `server/`)

- `apns.js`: provider-token is valid ES256, has `kid`/`iss`, cached < 1h.
- `sendSubscription`: `platform:'ios'` → calls apns and **not** web-push; `'web'`
  unchanged; APNs 410 → row set `active:false`.
- `/native-subscribe`: customer vs admin attribution; re-POST same token → single
  row (upsert), reactivates.

## 7. Risk / rollout

- Web-push path is byte-for-byte unchanged; iOS rows are purely additive
  (`platform` defaults `'web'`).
- Fail-soft if APNs env is unset (`skipped: 'apns_not_configured'`) — safe to
  merge before the secrets are added.
- Validate against the **sandbox** host first (`APNS_PRODUCTION` unset) with a dev
  build, then flip to prod for the App Store build.

---

### Effort

Backend PR ≈ **2–3 days** (sender + migration + route + tests). It's the only
net-new server work for the iOS app; the rest of the lift is the Capacitor shell
(spike) + App Store Connect listing/review.

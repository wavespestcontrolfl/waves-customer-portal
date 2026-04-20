# WavesPay — Stripe Tap-to-Pay iPhone shell

Native iOS app that pairs with the Waves admin portal's signed-handoff
Tap-to-Pay flow. Receives a `wavespay://collect?t=<jwt>` deep link from the
portal, validates the token, and uses Stripe Terminal iOS SDK to collect
card payments via **Tap to Pay on iPhone** (no separate reader hardware —
the iPhone's NFC chip is the reader).

## What's in this folder

```
ios/WavesPay/
├── README.md                 — this file
├── Sources/                  — Swift source files (drop into Xcode project)
│   ├── WavesPayApp.swift     — app entry + URL scheme handler
│   ├── AppState.swift        — central state, deep-link parser, JWT reader
│   ├── Keychain.swift        — JWT storage
│   ├── API.swift             — portal HTTP client
│   ├── TerminalManager.swift — Stripe Terminal SDK wrapper
│   ├── RootView.swift        — root router + success/failure/loading states
│   ├── LoginView.swift       — tech email + password sign-in
│   └── CollectView.swift     — amount screen + "Tap to Collect" button
└── Resources/
    ├── Info.plist.snippet.xml — URL scheme + location permission keys
    └── WavesPay.entitlements  — Tap-to-Pay proximity-reader entitlement
```

There's **no `.xcodeproj` in this folder** — you create the Xcode project
once in Xcode, then drop the Swift files into it. This is intentional: a
hand-written pbxproj is brittle and Xcode's wizard produces the right
layout in 10 seconds.

---

## One-time setup

### 1. Apple Developer prerequisites

Tap to Pay on iPhone is gated on three things from Apple:

1. **A paid Apple Developer account** in the same Team that owns the app.
   Team ID: `BMNXJ4Q89M` (already used for the wallet-pass planning).
2. **Request the Tap-to-Pay entitlement**:
   → https://developer.apple.com/contact/request/tap-to-pay-on-iphone
   Apple typically approves within a few business days. Mention Stripe
   as the payment processor in the form.
3. **A real iPhone** — Tap to Pay does not work in the simulator. iPhone
   XS or newer, running iOS 16.7 or later.

### 2. Stripe prerequisites

You already have `TERMINAL_HANDOFF_SECRET` and the portal routes set up
(`/api/stripe/terminal/handoff`, `/validate-handoff`, `/payment-intent`,
`/connection-token`). You also need:

1. **A Stripe Terminal Location** created for the Waves business address.
   Dashboard → Terminal → Locations → Create. Copy the `tml_…` ID — you'll
   paste it into `STRIPE_TERMINAL_LOCATION_ID` on Railway.
2. **`STRIPE_TERMINAL_LOCATION_ID`** env var set on Railway so
   `/connection-token` scopes to that location.

### 3. Create the Xcode project

1. Open Xcode → **File → New → Project…**
2. Choose **iOS → App**.
3. Fill in:
    - Product Name: `WavesPay`
    - Team: your Waves Apple Developer team
    - Organization Identifier: `com.wavespestcontrol`
    - Bundle Identifier will auto-fill to `com.wavespestcontrol.WavesPay`
    - Interface: **SwiftUI**
    - Language: **Swift**
    - Storage: **None**
    - Include Tests: your call
4. Save the project **inside `ios/WavesPay/`** (same folder as this README).
   You should end up with `ios/WavesPay/WavesPay.xcodeproj`.

### 4. Drop in the source files

1. In Finder, delete the `ContentView.swift` and `WavesPayApp.swift` that
   Xcode auto-generated inside the new project folder — the files in
   `Sources/` replace them.
2. In Xcode's left sidebar, right-click the `WavesPay` group → **Add Files
   to "WavesPay"…** → select every `.swift` file in `Sources/`.
   Check **Copy items if needed: OFF** (they stay in `Sources/`) and
   **Add to targets: WavesPay**.
3. Build once (⌘B). The build will fail because the Stripe Terminal SDK
   isn't installed yet — that's the next step.

### 5. Add the Stripe Terminal SDK (SPM)

1. In Xcode, select the `WavesPay` project (blue icon at top of sidebar).
2. Tab: **Package Dependencies** → **+**
3. Enter: `https://github.com/stripe/stripe-terminal-ios`
4. Dependency Rule: **Up to Next Major Version** starting from `3.8.0`
   (or the latest 3.x as of your install).
5. Add the `StripeTerminal` product to the `WavesPay` target.
6. Build again (⌘B) — should now succeed.

### 6. Configure Info.plist + entitlements

1. Open the `WavesPay` target → **Info** tab. Right-click → Open As →
   Source Code.
2. Paste the contents of `Resources/Info.plist.snippet.xml` inside the
   outer `<dict>`. Save.
3. Add the entitlements file:
    - **Signing & Capabilities** tab → **+ Capability** — there's no named
      capability for Tap to Pay, so instead: right-click the target's
      **Code Signing Entitlements** build setting → point it at
      `Resources/WavesPay.entitlements`. Or drag the file into the
      project navigator and set `CODE_SIGN_ENTITLEMENTS` manually.
4. **Deployment Target**: set to **iOS 16.7** minimum.

### 7. Backend env vars

On Railway (main service):

| Var | Value |
|---|---|
| `TERMINAL_HANDOFF_SECRET` | already set |
| `STRIPE_TERMINAL_LOCATION_ID` | `tml_…` (from Stripe Dashboard, step 2) |
| `HANDOFF_MINT_RATE_LIMIT_PER_HOUR` | `20` (default; raise only with reason) |

### 8. First build + install on a real iPhone

1. Plug your iPhone into your Mac.
2. Xcode → Product → Destination → choose your device.
3. Run (⌘R). First launch will prompt for location permission — allow.
4. Sign in with your tech email + password.
5. Leave the app on Idle.

### 9. Test the flow end-to-end

1. On your iPhone, open Safari and log into the admin portal.
2. Open an unpaid invoice → tap a **Charge now** button.
3. The portal hits `/handoff`, gets back `wavespay://collect?t=<jwt>`, and
   your browser prompts to open WavesPay. Tap **Open**.
4. WavesPay validates the token (shows the amount + customer name).
5. Tap **Tap to Collect** — Apple's Tap to Pay sheet appears.
6. Tap a test card (Stripe's test cards work in TEST mode; real cards
   work in LIVE). The sheet dismisses, you see the success screen.
7. The portal's invoice flips to paid via the usual webhook — no extra
   round-trip from the iOS app required.

---

## Architecture in one paragraph

The portal's PWA never hand-rolls a `wavespay://` URL; it always calls
`/api/stripe/terminal/handoff` first, which mints a 60-second HMAC-signed
JWT with an embedded `jti`, `invoice_id`, and `amount_cents`, and returns
the deep link. iOS parses the `t` parameter, decodes the JWT's `jti` claim
locally (the server verified the signature), and hits `/validate-handoff`
to atomically burn the `jti` and fetch the authoritative invoice state.
The tech then taps **Collect**; iOS hits `/payment-intent` with the `jti`
to create a `card_present` PaymentIntent scoped to that handoff row.
Stripe Terminal's on-device flow takes over: discover the synthetic
Tap-to-Pay reader, connect, collect payment method (NFC sheet appears),
confirm. Success goes back to the portal via the existing Stripe webhook
— iOS does not need to tell the portal anything.

## Security notes

- The JWT's signature is verified server-side on `/validate-handoff`. The
  client only reads claims; never trust `jti`, `amount_cents`, or
  `invoice_id` from a decoded-but-unverified token for anything that
  matters.
- Tech JWT stored in Keychain with `kSecAttrAccessibleAfterFirstUnlock`.
  Survives reboots but requires the device to have been unlocked once.
- No biometric gating on the tech login for v1. The real authorization
  lives in the handoff token (60-second TTL, one-time use).

## Troubleshooting

- **"No tap-to-pay reader found"** during discovery — most likely cause:
  the entitlement hasn't been approved by Apple yet, or the app is running
  in the simulator. Confirm on a real device with the entitlement active.
- **401 on `/connection-token`** — tech JWT expired or was rotated. Sign
  out and sign back in.
- **410 `replay` on `/validate-handoff`** — the token was already used.
  The portal's Charge now button needs to mint a fresh handoff.
- **409 `invoice_amount_changed`** — admin edited the invoice total
  between mint and validate. Close the flow and re-tap Charge now.

## What's intentionally NOT here (future work)

- Receipt surface inside the app. The portal's own receipt SMS handles
  this; iOS stays focused on collect-and-confirm.
- Manual PaymentIntent retrieval / retry UI. If the NFC flow errors out,
  the tech re-handoffs — simpler than maintaining an iOS-side retry
  state machine.
- Background reader keep-alive. The SDK disconnects when the app is
  backgrounded, which is fine for the door-to-door flow.

# Waves Customer Portal — API Documentation

Base URL: `https://portal.wavespestcontrol.com/api` (production)  
Base URL: `http://localhost:3001/api` (development)

## Authentication

The customer API sections below require a Bearer token in the Authorization
header unless an endpoint is explicitly identified as public:
```
Authorization: Bearer <jwt_token>
```

`POST /auth/send-code`, `POST /auth/verify-code`, and `POST /auth/refresh` are
the public authentication entry points. `GET /auth/me` requires the customer
Bearer token. Health checks and provider-signed or tokenized public routes
outside `/auth` have their own contracts; see
[`docs/public-route-contracts.md`](public-route-contracts.md).

### POST /auth/send-code
Send OTP verification code to customer's phone via Twilio.

**Request:**
```json
{ "phone": "+19415550147" }
```

**Response (200):**
```json
{ "success": true, "message": "If an account exists for that number, a verification code has been sent." }
```

This uniform anti-enumeration response is also returned for an unknown number
or a delivery failure. A 200 response does not confirm account existence or
SMS delivery.

### POST /auth/verify-code
Verify OTP and receive JWT tokens.

**Request:**
```json
{ "phone": "+19415550147", "code": "123456" }
```

**Response (200):**
```json
{
  "token": "eyJ...",
  "refreshToken": "eyJ...",
  "customer": {
    "id": "uuid",
    "firstName": "Jennifer",
    "lastName": "Martinez",
    "tier": "Gold"
  }
}
```

### POST /auth/refresh
Refresh an expired JWT token.

### GET /auth/me
Get full customer profile including property details and notification preferences.

---

## Services

### GET /services
List service history with products applied.

**Query params:** `limit` (default 20), `offset`, `type` (filter by service type)

**Response:**
```json
{
  "services": [{
    "id": "uuid",
    "date": "2026-03-25",
    "type": "Lawn Care Visit #3",
    "status": "completed",
    "technician": "Marcus W.",
    "notes": "Applied pre-emergent...",
    "soilTemp": 68.0,
    "thatchMeasurement": 0.60,
    "products": [
      { "product_name": "Celsius WG", "product_category": "herbicide", "moa_group": "Group 2" }
    ],
    "hasPhotos": true,
    "photoCount": 2
  }],
  "total": 7,
  "limit": 20,
  "offset": 0
}
```

### GET /services/:id
Single service detail with signed photo URLs.

### GET /services/stats/summary
Aggregated stats: services YTD, Celsius application count (vs. 3/year cap), thatch measurements over time.

---

## Schedule

### GET /schedule
Upcoming scheduled services within `days` window (default 90).

### GET /schedule/next
Next upcoming service only.

### POST /schedule/:id/confirm
Customer confirms an appointment. Changes status to `confirmed`.

### POST /schedule/:id/reschedule
Customer requests a reschedule.

**Request:**
```json
{
  "preferredDate": "2026-04-15",
  "notes": "I'll be out of town on the 8th"
}
```

---

## Billing (Stripe)

### GET /billing
Payment history with card details.

### GET /billing/balance
Current balance, upcoming charges, monthly rate, next charge date.

### GET /billing/cards
All payment methods on file with their card or bank details, verification
state, and default/autopay status.

### POST /billing/cards/setup-intent
Create a Stripe SetupIntent for the payment methods the client wants to offer.
`paymentMethodType` accepts `card`, `us_bank_account`, or `card_or_bank` and
defaults to `card`.

**Request:**
```json
{ "paymentMethodType": "card_or_bank" }
```

**Response:**
```json
{
  "clientSecret": "seti_..._secret_...",
  "setupIntentId": "seti_...",
  "publishableKey": "pk_...",
  "paymentMethodTypes": ["card", "us_bank_account"]
}
```

The server may reduce a bank-inclusive request to card-only when portal ACH is
disabled. Clients must use the returned `paymentMethodTypes` as the effective
set.

### POST /billing/cards
Save a payment method after confirming the Stripe SetupIntent with Stripe.
The request supports `setupIntentId` (required) and `paymentMethodId`
(optional). When `paymentMethodId` is omitted, the server resolves it from the
SetupIntent; when supplied, it must match the SetupIntent's payment method.
Bank saves require portal ACH to remain enabled; otherwise this endpoint
returns `409` before saving the method or recording consent.

Two confirmation outcomes are accepted:

- `succeeded` saves the method immediately. A bank method is marked verified;
  the route records consent and attempts Auto Pay enrollment.
- `requires_action` with `next_action.type = verify_with_microdeposits` saves
  the bank method as pending verification and records consent, but does not
  make it default or enroll it in Auto Pay. Verification completion is handled
  later through Stripe's verification flow.

Other incomplete SetupIntent states return `409` without saving through this
endpoint.

**Request:**
```json
{ "setupIntentId": "seti_...", "paymentMethodId": "pm_..." }
```

### DELETE /billing/cards/:id
Remove a card from file.

### PUT /billing/cards/:id/default
Set a card as the default payment method.

---

## Notifications (Twilio)

### GET /notifications/preferences
Current SMS/email notification preferences.

### PUT /notifications/preferences
Update one or more notification preferences.

**Request:**
```json
{
  "serviceReminder24h": true,
  "techEnRoute": true,
  "serviceCompleted": true,
  "seasonalTips": true,
  "smsEnabled": true
}
```

Legacy clients may still send `billingReminder`; the server accepts and
discards that compatibility field, so it does not change a preference.

---

## Health

### GET /health
Service health check. Returns status, service name, timestamp, environment.

---

## Automated Jobs (Internal)

These run on cron schedules and are not exposed as API endpoints:

| Job | Schedule | Description |
|-----|----------|-------------|
| Appointment Reminders | Every 15 minutes | Process persisted 72-hour and 24-hour appointment reminders that are due |
| Monthly Billing | Daily 8:00 AM ET | Process Stripe autopay for customers whose configured billing day is today |
| Autopay Pre-charge Reminders | Daily 9:00 AM ET | Notify eligible customers about scheduled charges three days out |

## Error Responses

All errors follow this format:
```json
{
  "error": "Human-readable error message",
  "code": "OPTIONAL_ERROR_CODE"
}
```

Common HTTP status codes: 400 (validation), 401 (auth required/expired), 404 (not found), 429 (rate limited), 500 (server error).

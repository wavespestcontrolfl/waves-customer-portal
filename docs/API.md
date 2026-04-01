# Waves Customer Portal — API Documentation

Base URL: `https://portal.wavespestcontrol.com/api` (production)  
Base URL: `http://localhost:3001/api` (development)

## Authentication

All endpoints except `/auth/*` require a Bearer token in the Authorization header:
```
Authorization: Bearer <jwt_token>
```

### POST /auth/send-code
Send OTP verification code to customer's phone via Twilio.

**Request:**
```json
{ "phone": "+19415550147" }
```

**Response (200):**
```json
{ "success": true, "message": "Verification code sent" }
```

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

## Billing (Square)

### GET /billing
Payment history with card details.

### GET /billing/balance
Current balance, upcoming charges, monthly rate, next charge date.

### GET /billing/cards
All cards on file with brand, last four, expiry, default/autopay status.

### POST /billing/cards
Add a new card using a Square card nonce from the Web Payments SDK.

**Request:**
```json
{ "cardNonce": "cnon:card-nonce-ok" }
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
  "billingReminder": false,
  "seasonalTips": true,
  "smsEnabled": true
}
```

---

## Health

### GET /health
Service health check. Returns status, service name, timestamp, environment.

---

## Automated Jobs (Internal)

These run on cron schedules and are not exposed as API endpoints:

| Job | Schedule | Description |
|-----|----------|-------------|
| Service Reminders | Daily 8:00 AM ET | SMS to customers with services tomorrow |
| Monthly Billing | 1st of month 6:00 AM ET | Process autopay charges via Square |
| Billing Reminders | 28th of month 10:00 AM ET | SMS to opted-in customers about upcoming charge |

## Error Responses

All errors follow this format:
```json
{
  "error": "Human-readable error message",
  "code": "OPTIONAL_ERROR_CODE"
}
```

Common HTTP status codes: 400 (validation), 401 (auth required/expired), 404 (not found), 429 (rate limited), 500 (server error).

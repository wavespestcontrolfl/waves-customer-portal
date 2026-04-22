# Deployment Guide — Waves Customer Portal

## Recommended: Railway (Simplest Full-Stack Deploy)

Railway handles Node.js + PostgreSQL with minimal configuration.

### Step 1: Prepare Repository
```bash
# Initialize git if not already
cd waves-portal
git init
echo "node_modules/\n.env\n*.log\nclient/dist/" > .gitignore
git add .
git commit -m "Initial commit — Waves Customer Portal"

# Push to GitHub
gh repo create waves-customer-portal --private --push
```

### Step 2: Create Railway Project
1. Go to https://railway.app and sign in with GitHub
2. Click "New Project" → "Deploy from GitHub Repo"
3. Select your `waves-customer-portal` repository
4. Railway auto-detects Node.js

### Step 3: Add PostgreSQL
1. In your Railway project, click "+ New" → "Database" → "PostgreSQL"
2. Railway automatically sets `DATABASE_URL` for your service

### Step 4: Set Environment Variables
In Railway dashboard → your service → "Variables" tab, add:

```
NODE_ENV=production
JWT_SECRET=<generate with: openssl rand -hex 32>
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=<your auth token>
TWILIO_PHONE_NUMBER=+1941XXXXXXX
TWILIO_VERIFY_SERVICE_SID=VAxxxxxxxxxxxxxxxxxxxxxxxxx
STRIPE_SECRET_KEY=your_stripe_secret_key_here
STRIPE_PUBLISHABLE_KEY=your_stripe_publishable_key_here
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret_here
AWS_ACCESS_KEY_ID=AKIAxxxxxxxxxxxxxxxxx
AWS_SECRET_ACCESS_KEY=<your secret>
AWS_REGION=us-east-1
S3_BUCKET=waves-pest-control-photos
CLIENT_URL=https://your-app.railway.app
```

### Step 5: Configure Build & Start
In Railway → Settings:
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Root Directory:** `/` (default)

### Step 6: Run Migrations
In Railway → your service → "Shell" tab:
```bash
cd server && npx knex migrate:latest
npx knex seed:run  # only for demo data
```

### Step 7: Custom Domain
1. Railway → Settings → "Custom Domain"
2. Add `portal.wavespestcontrol.com`
3. Add CNAME record in your DNS:
   - Host: `portal`
   - Value: `<your-app>.railway.app`

---

## Twilio Setup

### 1. Create Twilio Account
- Sign up at https://twilio.com
- Get Account SID and Auth Token from Console dashboard

### 2. Get a Phone Number
- Console → Phone Numbers → Buy a Number
- Choose a 941 area code number for local SWFL presence
- Enable SMS capability

### 3. Create Verify Service
- Console → Verify → Services → Create new
- Name: "Waves Customer Portal"
- Channel: SMS
- Code length: 6 digits
- Note the Service SID (starts with VA)

### 4. Messaging Setup
- Console → Messaging → Services → Create
- Add your phone number to the service
- This handles outbound SMS for notifications

**Estimated cost:** ~$1/month for the phone number + $0.0079/SMS sent

---

## Stripe Setup

### 1. Create Stripe Account
- Go to https://dashboard.stripe.com and sign up
- Complete business verification for live mode

### 2. Get API Keys
- Dashboard → Developers → API keys
- Copy the Secret Key (live or test; prefixed `sk_`)
- Copy the Publishable Key (live or test; prefixed `pk_`)
- Use test keys for development first

### 3. Payment Element (Frontend)
The frontend uses Stripe's Payment Element to securely collect card,
Apple Pay, Google Pay, and ACH payments. No separate app ID is needed —
the publishable key drives the client.

### 4. Configure Webhook
- Dashboard → Developers → Webhooks → Add endpoint
- Endpoint URL: `https://portal.wavespestcontrol.com/api/webhooks/stripe`
- Events: `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `charge.refunded`, `customer.subscription.updated`,
  `invoice.payment_succeeded`, `invoice.payment_failed`
- Copy the signing secret (prefixed `whsec_`) into `STRIPE_WEBHOOK_SECRET`

### 5. Go Live
- Switch from test keys to live keys in Railway variables
- Verify webhook endpoint is receiving events on the live key
- Run a $1 live test charge end-to-end

**Stripe fees:** 2.9% + $0.30 per card transaction; ACH 0.8% (capped at $5)

---

## AWS S3 Setup (Service Photos)

### 1. Create S3 Bucket
```bash
aws s3 mb s3://waves-pest-control-photos --region us-east-1
```

### 2. Configure CORS
```json
{
  "CORSRules": [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedOrigins": ["https://portal.wavespestcontrol.com"],
    "MaxAgeSeconds": 3600
  }]
}
```

### 3. Create IAM User
Create an IAM user with S3 access limited to your bucket.
Use the access key/secret in your environment variables.

---

## DNS / Domain Setup

Add these DNS records for `wavespestcontrol.com`:

| Type  | Host    | Value                          |
|-------|---------|--------------------------------|
| CNAME | portal  | your-app.railway.app           |

SSL is handled automatically by Railway.

---

## Post-Deployment Checklist

- [ ] Database migrations run successfully
- [ ] Twilio test SMS sends correctly
- [ ] Stripe test payment processes
- [ ] Stripe webhook endpoint receives events (check signing secret)
- [ ] Login flow works (send code → verify → dashboard)
- [ ] Service history loads from database
- [ ] Notification preferences save and persist
- [ ] Cron jobs fire at scheduled times
- [ ] Switch Stripe from test keys to live keys
- [ ] Custom domain + SSL configured
- [ ] Rate limiting tested
- [ ] Error monitoring set up (Sentry recommended)

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
SQUARE_ACCESS_TOKEN=EAAAxxxxxxxxxxxxxxxxxxxxxxxxx
SQUARE_LOCATION_ID=LIDxxxxxxxxxxxxxxxxx
SQUARE_ENVIRONMENT=production
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

## Square Setup

### 1. Create Square Developer Account
- Go to https://developer.squareup.com
- Create an application: "Waves Customer Portal"

### 2. Get Credentials
- Dashboard → your app → Credentials
- Copy Access Token and Location ID
- Use Sandbox credentials for testing first

### 3. Web Payments SDK (Frontend)
The frontend uses Square's Web Payments SDK to securely tokenize cards.
Add your Application ID to the client:
```
VITE_SQUARE_APP_ID=sandbox-sq0idb-xxxxxxxxxxxxx
```

### 4. Go Live
- Submit your app for review in Square Developer Dashboard
- Switch `SQUARE_ENVIRONMENT` from `sandbox` to `production`
- Use production Access Token

**Square fees:** 2.9% + $0.30 per transaction (standard processing)

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
- [ ] Square sandbox payment processes
- [ ] Login flow works (send code → verify → dashboard)
- [ ] Service history loads from database
- [ ] Notification preferences save and persist
- [ ] Cron jobs fire at scheduled times
- [ ] Switch Square to production environment
- [ ] Custom domain + SSL configured
- [ ] Rate limiting tested
- [ ] Error monitoring set up (Sentry recommended)

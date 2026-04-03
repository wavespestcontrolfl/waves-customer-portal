const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

module.exports = {
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

  db: {
    connectionString: process.env.DATABASE_URL,
    pool: {
      min: parseInt(process.env.DB_POOL_MIN) || 2,
      max: parseInt(process.env.DB_POOL_MAX) || 10,
    },
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiry: process.env.JWT_EXPIRY || '7d',
    refreshExpiry: process.env.REFRESH_TOKEN_EXPIRY || '30d',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID,
  },

  square: {
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    locationId: process.env.SQUARE_LOCATION_ID,
    environment: process.env.SQUARE_ENVIRONMENT || 'sandbox',
  },

  bouncie: {
    clientId: process.env.BOUNCIE_CLIENT_ID,
    clientSecret: process.env.BOUNCIE_CLIENT_SECRET,
    apiKey: process.env.BOUNCIE_API_KEY,
    accessToken: process.env.BOUNCIE_ACCESS_TOKEN,
    refreshToken: process.env.BOUNCIE_REFRESH_TOKEN,
    vehicleImei: process.env.BOUNCIE_VEHICLE_IMEI,
    redirectUri: process.env.BOUNCIE_REDIRECT_URI,
    apiBase: 'https://api.bouncie.dev/v1',
    authBase: 'https://auth.bouncie.com',
  },

  s3: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET,
    photoPrefix: process.env.S3_PHOTO_PREFIX || 'service-photos/',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 500,
  },
};

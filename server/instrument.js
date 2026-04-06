const Sentry = require("@sentry/node");

Sentry.init({
  dsn: "https://b63c130c0ad93998528d5ff82250e68d@o4511171673849856.ingest.us.sentry.io/4511171681255425",
  sendDefaultPii: true,
  environment: process.env.NODE_ENV || "production",
  serverName: "portal.wavespestcontrol.com",
});

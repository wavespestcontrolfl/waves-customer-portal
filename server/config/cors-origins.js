/**
 * Single source of truth for the cross-origin allowlist.
 *
 * Both the Express HTTP server and the Socket.io server consume this
 * list. Defining it twice is how production breaks at 11pm on a Friday
 * when a new domain gets added — keep it in one file.
 *
 * config.clientUrl is included so dev (localhost:5173) and any
 * environment-specific override (CLIENT_URL on Railway) automatically
 * flow through. The three production hostnames are the customer-facing
 * portal + the marketing apex + www.
 */
const config = require('./');

const allowedOrigins = [
  config.clientUrl,
  'https://portal.wavespestcontrol.com',
  'https://wavespestcontrol.com',
  'https://www.wavespestcontrol.com',
];

module.exports = { allowedOrigins };

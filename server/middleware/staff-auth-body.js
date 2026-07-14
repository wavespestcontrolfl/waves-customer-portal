const express = require('express');

// Staff auth payloads contain only an email, password, or 43-character reset
// token. Parse them before the application's legacy 50 MB global parsers so an
// unauthenticated request cannot spend that full CPU/memory budget per attempt.
const STAFF_AUTH_BODY_LIMIT = '16kb';
const staffAuthBodyParsers = [
  express.json({ limit: STAFF_AUTH_BODY_LIMIT }),
  express.urlencoded({ extended: false, limit: STAFF_AUTH_BODY_LIMIT }),
];

module.exports = {
  STAFF_AUTH_BODY_LIMIT,
  staffAuthBodyParsers,
};

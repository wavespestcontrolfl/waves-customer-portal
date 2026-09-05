'use strict';

// Managed local processes receive an allowlisted environment from scripts/dev.
// Never refill missing provider credentials from the checkout's legacy .env.
function loadEnv() {
  if (process.env.WAVES_LOCAL_DEV === '1') {
    if (require('../utils/railway-deployment').isRailwayDeployment()) {
      throw new Error('WAVES_LOCAL_DEV is forbidden in a Railway deployment.');
    }
    return;
  }
  require('dotenv').config({ path: require('path').join(__dirname, '../..', '.env') });
}

module.exports = loadEnv;

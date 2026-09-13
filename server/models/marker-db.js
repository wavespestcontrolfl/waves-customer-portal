// One connection outside the root pool for the durable "a provider request
// follows" transitions written from inside a held handoff transaction
// (visit-groups markVisitNotificationProviderStart, the transactional email
// retry rail's handoff-started marker). The root pool's floor is 2 and a cron
// job pins one of those, so a second root-pool acquisition inside a held
// transaction would wait on itself; these single-statement writes serialize
// on their own connection instead. Built lazily so a process that never
// hands off never opens it.
const knex = require('knex');
const knexConfig = require('../knexfile');
const config = require('../config');

let instance = null;
function markerDb() {
  if (!instance) {
    const base = knexConfig[config.nodeEnv || 'development'];
    instance = knex({ ...base, pool: { min: 0, max: 1 } });
  }
  return instance;
}

module.exports = markerDb;

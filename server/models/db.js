const knex = require('knex');
const knexConfig = require('../knexfile');
const config = require('../config');

const env = config.nodeEnv || 'development';

if (!knexConfig[env]) {
  throw new Error(
    `[db.js] knexfile has no config for NODE_ENV='${env}'. ` +
    `Available keys: ${Object.keys(knexConfig).join(', ')}. ` +
    `Add a '${env}' entry to server/knexfile.js.`
  );
}

const db = knex(knexConfig[env]);

module.exports = db;

const knex = require('knex');
const knexConfig = require('../knexfile');
const config = require('../config');

const env = config.nodeEnv || 'development';
const db = knex(knexConfig[env]);

module.exports = db;

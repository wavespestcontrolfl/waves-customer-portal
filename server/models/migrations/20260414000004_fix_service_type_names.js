/**
 * Fix scheduled_services records where service_type contains
 * Square variation descriptions (price/duration) instead of actual service names.
 */
exports.up = async (knex) => {
  // Fix entries like "- 1 hour - $105.30" or "$89.00" stored as service_type
  await knex.raw(`
    UPDATE scheduled_services
    SET service_type = 'General Pest Control'
    WHERE service_type ~ '^\\s*[-–—]?\\s*\\d+\\s*(hour|hr|min)'
       OR service_type ~ '^\\s*\\$\\d'
  `);
};

exports.down = async () => {};

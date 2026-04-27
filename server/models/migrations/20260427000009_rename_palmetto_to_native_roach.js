/**
 * Rename "Initial Palmetto Knockdown" → "Initial Native Roach Knockdown" so
 * the customer-facing name covers all of SWFL's native cockroach species
 * (American / palmetto, smoky brown, Australian, Florida woods), not just
 * palmetto. Also broadens the description to mention interior spray + bait,
 * which is what techs typically run on these visits.
 *
 * The service_key (`pest_initial_palmetto_knockdown`) is left in place — it's
 * an internal identifier only, and renaming it would force a coordinated FK
 * rewrite across service_records / scheduled_services. The display fields
 * (name / short_name / description) are the only thing customers and CSRs see.
 *
 * Pairs with the same wording change in:
 *   - server/services/pricing-engine/service-pricing.js (engine label + detail)
 *   - server/models/migrations/20260426000001_add_initial_roach_knockdown_services.js
 *     (so fresh DBs get the new strings on first run)
 */
exports.up = async function (knex) {
  await knex('services')
    .where('service_key', 'pest_initial_palmetto_knockdown')
    .update({
      name: 'Initial Native Roach Knockdown',
      short_name: 'Native Roach Initial',
      description: 'Heavier visit-1 treatment for new recurring pest customers reporting any of the native SWFL cockroaches (American / palmetto, smoky brown, Australian, Florida woods). Includes interior spray, crack-and-crevice in kitchen / bath / utility, perimeter granular, and bait gel placement at hot spots. Auto-added by the pest engine when recurring pest is booked with roachType=regular; pricing slides by footprint ($119 under 1,500 sf, $139 mid, $169 over 2,500 sf).',
    });

  await knex('services')
    .where('service_key', 'pest_initial_german_knockdown')
    .update({
      description: 'Heavier visit-1 treatment for new recurring pest customers reporting German cockroaches (small indoor / kitchen species). Includes interior spray, gel bait placement at hot spots, and an insect growth regulator to break the breeding cycle. Indoor breeding biology requires longer visit, heavier product rotation, and IGR-driven follow-up. NOT a substitute for the dedicated 3-visit German Roach Cleanout program for severe infestations — this is the auto-add for the everyday "I saw one or two" case. Auto-added by the pest engine when recurring pest is booked with roachType=german; pricing slides by footprint ($169 under 1,500 sf, $199 mid, $249 over 2,500 sf).',
    });
};

exports.down = async function (knex) {
  await knex('services')
    .where('service_key', 'pest_initial_palmetto_knockdown')
    .update({
      name: 'Initial Palmetto Knockdown',
      short_name: 'Palmetto Initial',
      description: 'Heavier visit-1 treatment for new recurring pest customers reporting palmetto / American cockroaches. Includes interior void treatment, crack-and-crevice in kitchen / bath / utility, perimeter granular, and bait gel placement at hot spots. Auto-added by the pest engine when recurring pest is booked with roachType=regular; pricing slides by footprint ($119 under 1,500 sf, $139 mid, $169 over 2,500 sf).',
    });

  await knex('services')
    .where('service_key', 'pest_initial_german_knockdown')
    .update({
      description: 'Heavier visit-1 treatment for new recurring pest customers reporting German cockroaches. Indoor breeding cycle requires longer visit, heavier product rotation, and IGR-driven follow-up. NOT a substitute for the dedicated 3-visit German Roach Cleanout program for severe infestations — this is the auto-add for the everyday "I saw one or two" case. Auto-added by the pest engine when recurring pest is booked with roachType=german; pricing slides by footprint ($169 under 1,500 sf, $199 mid, $249 over 2,500 sf).',
    });
};

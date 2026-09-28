/**
 * Supersedes the activation half of 20260928110000 / 20260928130000 (both
 * frozen once pushed). The Termite Inspection Service stays OFF until the
 * booking paths are ready for a $0 catalog service (Codex r4 on #5161):
 *   - the Intelligence Bar and phone booking save a $0 catalog price as
 *     NULL, which a per-application customer's completion bills as the fee;
 *   - the appointment tagger classifies "Termite Inspection" as a WDO and
 *     runs the WDO prep automation;
 *   - a monthly member's bare $0 still falls through to monthly_rate until
 *     the all-lanes $0 rule ships.
 * The discount re-scoping (member perk -> termite_inspection, never WDO)
 * stays in effect. A follow-up turns the service on.
 *
 * down() is a no-op: a rollback must never switch a catalog service on.
 */
exports.up = async function (knex) {
  await knex('services').where({ service_key: 'termite_inspection' }).update({
    is_active: false,
    updated_at: new Date(),
  });
};

exports.down = async function () {};

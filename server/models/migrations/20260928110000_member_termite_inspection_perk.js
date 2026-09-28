/**
 * The WaveGuard member perk is a free ANNUAL TERMITE INSPECTION, not a free
 * WDO (real-estate) inspection (owner 2026-09-28: "wdo is not free, if your a
 * waveguard member you get a free annual termite inspection").
 *
 *   1. waveguard_member_wdo and the legacy free_termite_inspection were both
 *      scoped to wdo_inspection (20260408000002). Re-scope both to the
 *      standalone termite_inspection service, so an operator can no longer
 *      pick a member discount that zeroes a WDO.
 *   2. Turn the Termite Inspection Service on, at $0 for now (owner
 *      2026-09-28: "just keep it at 0 for now"). A price and the
 *      once-every-12-months limit come later.
 *
 * down() restores the values 20260408000002 left (verified live 2026-09-28:
 * both rows scoped to wdo_inspection, the service inactive with no price).
 */
const PERK_DESCRIPTION = 'Free annual termite inspection for WaveGuard members (Bronze+). Termite Inspection Service only — never the real-estate WDO inspection.';

exports.up = async function (knex) {
  await knex('discounts').where({ discount_key: 'waveguard_member_wdo' }).update({
    name: 'WaveGuard Member Free Annual Termite Inspection',
    description: PERK_DESCRIPTION,
    service_key_filter: 'termite_inspection',
    updated_at: new Date(),
  });
  await knex('discounts').where({ discount_key: 'free_termite_inspection' }).update({
    description: `${PERK_DESCRIPTION} Legacy record — see also waveguard_member_wdo.`,
    service_key_filter: 'termite_inspection',
    updated_at: new Date(),
  });
  await knex('services').where({ service_key: 'termite_inspection' }).update({
    is_active: true,
    base_price: 0,
    updated_at: new Date(),
  });
};

exports.down = async function (knex) {
  await knex('discounts').where({ discount_key: 'waveguard_member_wdo' }).update({
    name: 'WaveGuard Member Discount (Termite Inspection)',
    description: 'Free WDO / termite inspection for any active WaveGuard member. Maps Square "WaveGuard Member Discount (Termite Inspection)" at 100%.',
    service_key_filter: 'wdo_inspection',
    updated_at: new Date(),
  });
  await knex('discounts').where({ discount_key: 'free_termite_inspection' }).update({
    description: 'Free WDO inspection for WaveGuard members (Bronze+). Legacy record — see also waveguard_member_wdo.',
    service_key_filter: 'wdo_inspection',
    updated_at: new Date(),
  });
  await knex('services').where({ service_key: 'termite_inspection' }).update({
    is_active: false,
    base_price: null,
    updated_at: new Date(),
  });
};

/**
 * Sync discount library with Square catalog + fix bugs
 *
 * Changes:
 *   1. ADD waveguard_member — generic 15% "WaveGuard Member" discount
 *      for any active WaveGuard member regardless of tier. Used in Square
 *      as a catch-all when tier-specific discount isn't applied.
 *
 *   2. ADD waveguard_member_wdo — 100% free WDO inspection for ALL
 *      WaveGuard members (maps Square's "WaveGuard Member Discount
 *      (Termite Inspection)" at 100%).
 *
 *   3. FIX free_termite_inspection — wrong service_key_filter value.
 *      Was: 'termite_inspection' (doesn't exist in services table)
 *      Now: 'wdo_inspection' (actual service_key for WDO inspections)
 *      Also updates requires_waveguard_tier from 'Silver' to 'Bronze'
 *      to match Square behavior where ALL members get it.
 */
exports.up = async function (knex) {
  // ── 1. Add WaveGuard Member Discount (generic 15%) ──
  const memberExists = await knex('discounts').where('discount_key', 'waveguard_member').first();
  if (!memberExists) {
    await knex('discounts').insert({
      discount_key: 'waveguard_member',
      name: 'WaveGuard Member Discount',
      description: 'Generic 15% WaveGuard member discount. Applied when a customer has any active WaveGuard membership but tier-specific discount is not used. Matches Square "WaveGuard Member Discount" line item.',
      discount_type: 'percentage',
      amount: 15,
      requires_waveguard_tier: 'Bronze',   // Bronze = any tier (Bronze+)
      is_waveguard_tier_discount: false,    // Not a tier discount — it's a manual/fallback
      is_auto_apply: false,                 // Manual apply — tier discounts auto-apply first
      is_stackable: false,
      stack_group: 'tier',                  // Competes with tier discounts, only one wins
      priority: 15,                         // Slightly lower priority than tier discounts (10)
      show_in_estimates: true,
      show_in_invoices: true,
      show_in_scheduling: false,
      sort_order: 5,
      color: '#0ea5e9',
      icon: '🛡️',
      is_active: true,
    });
  }

  // ── 2. Add WaveGuard Member WDO Discount (100% free inspection) ──
  const wdoExists = await knex('discounts').where('discount_key', 'waveguard_member_wdo').first();
  if (!wdoExists) {
    await knex('discounts').insert({
      discount_key: 'waveguard_member_wdo',
      name: 'WaveGuard Member Discount (Termite Inspection)',
      description: 'Free WDO / termite inspection for any active WaveGuard member. Maps Square "WaveGuard Member Discount (Termite Inspection)" at 100%.',
      discount_type: 'percentage',
      amount: 100,
      requires_waveguard_tier: 'Bronze',    // Any WaveGuard tier
      service_key_filter: 'wdo_inspection', // Only applies to WDO inspection service
      is_waveguard_tier_discount: false,
      is_auto_apply: true,                  // Auto-apply when WDO is booked for a member
      is_stackable: true,                   // Stacks — it's service-specific, won't double-dip
      priority: 5,                          // High priority — free service should apply first
      show_in_estimates: true,
      show_in_invoices: true,
      show_in_scheduling: true,
      sort_order: 6,
      color: '#f59e0b',
      icon: '🔍',
      is_active: true,
    });
  }

  // ── 3. Fix free_termite_inspection — wrong service_key_filter ──
  const freeTermite = await knex('discounts').where('discount_key', 'free_termite_inspection').first();
  if (freeTermite) {
    await knex('discounts')
      .where('discount_key', 'free_termite_inspection')
      .update({
        service_key_filter: 'wdo_inspection',          // Fix: was 'termite_inspection'
        requires_waveguard_tier: 'Bronze',              // Fix: was 'Silver' — all members get it
        description: 'Free WDO inspection for WaveGuard members (Bronze+). Legacy record — see also waveguard_member_wdo.',
        updated_at: new Date(),
      });
  }
};

exports.down = async function (knex) {
  // Remove the two new discounts
  await knex('discounts').where('discount_key', 'waveguard_member').del();
  await knex('discounts').where('discount_key', 'waveguard_member_wdo').del();

  // Revert free_termite_inspection to original values
  const freeTermite = await knex('discounts').where('discount_key', 'free_termite_inspection').first();
  if (freeTermite) {
    await knex('discounts')
      .where('discount_key', 'free_termite_inspection')
      .update({
        service_key_filter: 'termite_inspection',
        requires_waveguard_tier: 'Silver',
        description: 'Free termite inspection for Silver tier and above',
        updated_at: new Date(),
      });
  }
};

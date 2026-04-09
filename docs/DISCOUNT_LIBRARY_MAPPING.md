# Square Discounts → Discount Engine Mapping
## Waves Pest Control — Complete Discount Key Reference

> Canonical mapping from Square discount line items to `discounts.discount_key` in PostgreSQL.

---

### Square Catalog → DB Mapping

| Square Discount Name | discount_key | Type | Amount | Eligibility | Auto-Apply | Stack Group |
|---|---|---|---|---|---|---|
| Custom Discount (Variable %) | `custom_percent` | percentage | 0 (set at apply) | None — admin assigned | No | — |
| Custom Discount (Variable $) | `custom_dollar` | fixed_amount | 0 (set at apply) | None — admin assigned | No | — |
| Family & Friends Discount | `family_friends` | percentage | 15% | Admin assigned | No | relationship |
| Military Discount | `military` | percentage | 5% | `is_military` flag | Yes | — |
| Multi-Home Discount | `multi_home` | percentage | 10% | `has_multi_home` flag | Yes | — |
| New Customer Discount | `new_customer` | fixed_amount | $149.99 | No completed services | No | promo |
| Pre-Payment Discount | `prepayment` | percentage | 5% | Prepayment flag | No | — |
| WaveGuard Gold Discount | `waveguard_gold` | percentage | 15% | Gold tier | Yes | tier |
| WaveGuard Member Discount | `waveguard_member` | percentage | 15% | Any WaveGuard tier (Bronze+) | No | tier |
| WaveGuard Member Discount (Termite Inspection) | `waveguard_member_wdo` | percentage | 100% | Any WaveGuard tier + WDO service | Yes | — |
| WaveGuard Platinum Discount | `waveguard_platinum` | percentage | 20% | Platinum tier | Yes | tier |
| WaveGuard Referral | `referral` | fixed_amount | $50.00 | Referral flag | No | — |
| WaveGuard Silver Discount | `waveguard_silver` | percentage | 10% | Silver tier | Yes | tier |

### Also in DB (no Square equivalent)

| discount_key | Name | Notes |
|---|---|---|
| `waveguard_bronze` | WaveGuard Bronze | 0% — Bronze tier placeholder (no discount) |
| `senior` | Senior Discount | 5% for 65+. Not in Square — apply manually or via `is_senior` flag |
| `free_termite_inspection` | Free Termite Inspection | Legacy record — now superseded by `waveguard_member_wdo`. Still active for backward compat. |

---

### Stacking Rules

Discounts in the same `stack_group` compete — only the highest-priority one wins. Discounts without a `stack_group` or with `is_stackable: true` can combine freely.

**tier group** — Only one tier discount applies per invoice. Priority order: Bronze (0%) → Silver (10%) → Gold (15%) → Platinum (20%). The generic `waveguard_member` (15%) is also in this group as a fallback when tier isn't assigned.

**relationship group** — Family & Friends discount. Non-stackable within its group.

**promo group** — New Customer Special. Non-stackable within its group.

**Stackable discounts** (combine with tier): Military (5%), Multi-Home (10%), Prepayment (5%), Senior (5%), Referral ($50), WaveGuard Member WDO (100% on WDO only), Custom % and Custom $.

### When to Use `waveguard_member` vs Tier Discounts

The tier-specific discounts (`waveguard_silver`, `waveguard_gold`, `waveguard_platinum`) auto-apply based on the customer's `waveguard_tier` field. The generic `waveguard_member` discount exists for cases where:

1. A customer has an active WaveGuard membership but their tier hasn't been set in the system yet
2. Square was applying the flat "WaveGuard Member Discount" instead of tier-specific ones
3. Legacy invoices that used the generic 15% line item

Once all customers have proper tier assignments, `waveguard_member` can be deactivated in favor of the tier-specific auto-apply discounts.

---

### Bug Fix Applied

The original `free_termite_inspection` record had `service_key_filter: 'termite_inspection'` which doesn't match any `service_key` in the services table. The correct value is `wdo_inspection`. Migration `20260408000002` fixes this and also broadens eligibility from Silver+ to Bronze+ (all members) to match Square behavior.

# Square Catalog → Service Library Mapping
## Waves Pest Control — Complete Service Key Reference

> Use this as the canonical mapping when reconciling Square line items,
> booking types, or invoice descriptions to the `services.service_key` in PostgreSQL.

---

### Pest Control — One-Time Services

| Square Catalog Item | service_key | billing_type | pricing |
|---|---|---|---|
| Pest Control Service \| Billed One-Time | `pest_initial_cleanout` | one_time | Variable |
| Mosquito Control Service \| Billed One-Time | `mosquito_monthly` (or `mosquito_event`) | one_time | Variable |
| Mud Dauber Nest Removal Service \| Billed One-Time | `mud_dauber_removal` | one_time | Variable |
| Tick Control Service \| Billed One-Time | `tick_control` | one_time | Variable |
| Yellow Jacket Control Service \| Billed One-Time | `bee_wasp_removal` | one_time | Variable |
| Wasp Control Service \| Billed One-Time | `bee_wasp_removal` | one_time | Variable |
| Wildlife Trapping Service \| Billed One-Time | `wildlife_trapping` | one_time | Variable |

### Pest Control — Recurring Services

| Square Catalog Item | service_key | frequency | visits/yr |
|---|---|---|---|
| Semiannual Pest Control Service \| 2 Applications Per Year | `pest_general_semiannual` | semiannual | 2 |
| Quarterly Pest Control Service \| 4 Applications Per Year | `pest_general_quarterly` | quarterly | 4 |
| Bi-Monthly Pest Control Service \| 6 Applications Per Year | `pest_general_bimonthly` | bimonthly | 6 |
| Monthly Pest Control Service \| 12 Applications Per Year | `pest_general_monthly` | monthly | 12 |

### Rodent Control — One-Time Services

| Square Catalog Item | service_key | billing_type |
|---|---|---|
| Rodent Trapping Service \| Billed One-Time | `rodent_trapping` | one_time |
| Rodent Exclusion Service \| Billed One-Time | `rodent_exclusion_only` | one_time |
| Rodent Trapping & Exclusion Service \| Billed One-Time | `rodent_exclusion` | one_time |
| Rodent Trapping & Sanitation Service \| Billed One-Time | `rodent_trapping_sanitation` | one_time |
| Rodent Trapping, Exclusion & Sanitation Service \| Billed One-Time | `rodent_trapping_exclusion_sanitation` | one_time |
| Rodent Pest Control \| Billed One-Time | `rodent_general_one_time` | one_time |

### Rodent Control — Recurring Services

| Square Catalog Item | service_key | frequency | visits/yr |
|---|---|---|---|
| Rodent Bait Station Service \| Billed Annually | `rodent_monitoring` | annual | — |
| Rodent Bait Station Service \| Billed Every 3 Months | `rodent_monitoring` | quarterly | 4 |

### Termite Bond — Recurring Services

| Square Catalog Item | service_key | frequency | fixed price |
|---|---|---|---|
| Termite Bond (Billed Quarterly \| 10-Year Term) | `termite_bond_10yr` | quarterly | $45/ea |
| Termite Bond (Billed Quarterly \| 5-Year Term) | `termite_bond_5yr` | quarterly | $54/ea |
| Termite Bond (Billed Quarterly \| 1-Year Term) | `termite_bond_1yr` | quarterly | $60/ea |

### Termite Control — Recurring Services

| Square Catalog Item | service_key | frequency | pricing |
|---|---|---|---|
| Termite Monitoring Service \| 4 Applications Per Year | `termite_monitoring` | quarterly | $99/ea |
| Termite Active Annual Bait Station Service \| 1 Application Per Year | `termite_active_annual` | annual | $199/ea |
| Termite Active Bait Station Service \| 4 Applications Per Year | `termite_active_bait_quarterly` | quarterly | Variable |

### Termite Control — One-Time Services

| Square Catalog Item | service_key | billing_type |
|---|---|---|
| Termite Installation Setup \| Billed One-Time | `termite_installation_setup` | one_time |
| Termite Spot Treatment Service \| Billed One-Time | `termite_spot_treatment` | one_time |
| Termite Pretreatment Service \| Billed One-Time | `termite_pretreatment` | one_time |
| Termite Trenching Service \| Billed One-Time | `termite_trenching` | one_time |
| Termite Bait Station Cartridge Replacement | `termite_cartridge_replacement` | one_time |
| Slab Pre-Treat Termite \| Billed One-Time | `termite_slab_pretreat` | one_time |

### Tree & Shrub Care — Recurring Services

| Square Catalog Item | service_key | frequency | visits/yr |
|---|---|---|---|
| Every 6 Weeks Tree & Shrub Care Service \| 9 Applications Per Year | `tree_shrub_6week` | every_6_weeks | 9 |
| Bi-Monthly Tree & Shrub Care Service \| 6 Applications Per Year | `tree_shrub_program` | bimonthly | 6 |

### WaveGuard Membership

| Square Catalog Item | service_key | billing_type |
|---|---|---|
| WaveGuard Initial Setup \| Billed One-Time | `waveguard_initial_setup` | one_time |
| WaveGuard Membership (recurring) | `waveguard_membership` | recurring |

### General

| Square Catalog Item | service_key | billing_type |
|---|---|---|
| Waves Pest Control Appointment | `general_appointment` | one_time |

---

### Notes

- **Square "header" items** like "Pest Control Service — Recurring Services" are category groupings, not bookable services. They have no `service_key` and are not stored in the DB.
- **Rodent Bait Station** appears twice in Square with different billing cycles (annually vs quarterly). Both map to `rodent_monitoring` — differentiate by the `frequency` field or create a `rodent_monitoring_quarterly` key if you need distinct line items.
- Services already in the original seed (migration `20260401000105`) include: `pest_general_quarterly`, `pest_general_monthly`, `pest_initial_cleanout`, `lawn_fertilization`, `lawn_fungicide`, `lawn_insect_control`, `lawn_aeration`, `mosquito_monthly`, `mosquito_event`, `termite_liquid`, `termite_bait`, `termite_renewal`, `rodent_exclusion`, `rodent_monitoring`, `tree_shrub_program`, `palm_treatment`, `wdo_inspection`, `lawn_inspection`, `new_customer_inspection`, `fire_ant`, `flea_tick`, `bee_wasp_removal`, `waveguard_membership`.

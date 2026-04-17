# Vendor Codes

Stable integer codes for referencing vendors in seed migrations. The UUID `vendors.id` is the FK; the `code` is the stable human-readable handle. If a vendor is renamed or replaced, edit the vendor row — the code stays.

Codes assigned in original insertion order from `20260401000019_inventory.js:50-73`. Do not reorder. Append new vendors with `code = 24, 25, ...`.

| Code | Vendor                    | Type                  |
|------|---------------------------|-----------------------|
| 1    | SiteOne                   | primary               |
| 2    | Amazon                    | online                |
| 3    | Solutions Pest & Lawn     | online                |
| 4    | DoMyOwn                   | online                |
| 5    | Forestry Distributing     | online                |
| 6    | Chemical Warehouse        | online                |
| 7    | Seed World USA            | online                |
| 8    | Intermountain Turf        | online                |
| 9    | Keystone Pest Solutions   | online                |
| 10   | Veseris                   | distributor           |
| 11   | Ewing Outdoor Supply      | distributor           |
| 12   | GCI Turf Academy          | online                |
| 13   | DIY Pest Control          | online                |
| 14   | SprinklerJet              | online                |
| 15   | SeedBarn                  | online                |
| 16   | Reinders                  | distributor           |
| 17   | Sun Spot Supply           | regional              |
| 18   | Golf Course Lawn Store    | online                |
| 19   | Geoponics                 | manufacturer_direct   |
| 20   | Target Specialty Products | distributor           |
| 21   | BWI Companies             | distributor           |
| 22   | Helena Agri-Enterprises   | distributor           |
| 23   | TruGreen                  | competitor_reference  |

---

**Future parallel:** `products_catalog` uses name-based lookup (stable enough for branded chemicals like Bora-Care, Termidor SC). Revisit a `product_code` column if the catalog grows past ~50 products or rename churn begins.

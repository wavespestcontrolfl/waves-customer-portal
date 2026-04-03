# Job Scoring Formula

**Summary:** Weighted 0–100 scoring system for job priority in route ordering and slot protection. Higher score = protect the slot. Score drives route position, CSR booking, and revenue-aware dispatch.

**Category:** protocols
**Tags:** job-score, revenue, upsell, renewal, route-efficiency, priority, scoring

---

## Formula

```
Job Score (0–100) =
  Revenue weight      (40%) → service revenue tier × 40
  Renewal probability (25%) → customer tier score × 25
  Upsell potential    (20%) → category + tier score × 20
  Route efficiency    (15%) → drive time score × 15
```

## Revenue Weight (max 40 pts)

| Service | Pts |
|---------|-----|
| Termite Bora-Care install | 38–40 |
| WDO inspection | 35–38 |
| Termite spot/foam | 30–35 |
| Tree & shrub (injection) | 28–32 |
| German roach | 22–28 |
| Lawn care full service | 22–28 |
| General pest (initial) | 20–26 |
| Mosquito treatment | 18–24 |
| Stinging insect | 18–24 |
| General pest (recurring) | 16–22 |
| Rodent stations | 16–20 |
| Callback/retreat | 14–18 |

## Renewal Probability (max 25 pts)

| Tier | Pts |
|------|-----|
| Platinum WaveGuard | 23–25 |
| Gold WaveGuard | 20–22 |
| Canceled account at risk | 18–22 |
| Silver WaveGuard | 16–19 |
| Bronze WaveGuard | 12–15 |
| Recurring non-WaveGuard | 10–14 |
| First-time customer | 8–12 |
| One-time / no program | 4–8 |

## Upsell Potential (max 20 pts)

| Situation | Pts |
|-----------|-----|
| New lead / estimate | 18–20 |
| Inspection job | 16–19 |
| Platinum member | 12–16 |
| Gold member | 10–14 |
| Silver / Bronze | 6–10 |
| Stable recurring program | 4–8 |
| One-time only customer | 2–5 |

## Route Efficiency (max 15 pts)

| Drive time from prior stop | Pts |
|---------------------------|-----|
| < 5 min | 14–15 |
| 5–10 min | 12–14 |
| 10–15 min | 10–12 |
| 15–20 min | 8–10 |
| 20–30 min | 3–6 |
| 30+ min | 0–3 (flag for review) |

## Score Bands

| Score | Priority | Action |
|-------|----------|--------|
| 85–100 | Critical | Protect — never move or compress |
| 70–84 | High | Flag before moving |
| 55–69 | Standard | Normal route placement |
| 40–54 | Low | Can compress or move to adjacent day |
| < 40 | Deprioritize | Consider rescheduling |

## Special Adjustments

- Callback / retreat: +15 pts flat (retention value)
- Canceled account at risk: +20 pts flat (winback value)
- Inspection with termite evidence found: +10 pts
- Premium add-on (aeration, mosquito, termite, exclusion, seeding): +8 pts

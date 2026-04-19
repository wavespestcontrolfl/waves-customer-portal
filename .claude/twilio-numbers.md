# Waves Twilio Number Directory

Source: user-provided 2026-04-18. Used by reply-from routing, spam-block
middleware, and inbound webhook → location resolution.

## Main Office Lines (real customer-facing)

| Number | Location |
|---|---|
| (941) 318-7612 | Lakewood Ranch — HQ (Pest) ⭐ main line |
| (941) 297-2817 | Parrish (Pest) |
| (941) 297-2606 | Sarasota (Pest) |
| (941) 297-3337 | Venice (Pest) |

## Pest Control — Domain Tracking

| Number | Domain / Path | Area |
|---|---|---|
| (941) 297-5749 | wavespestcontrol.com | General |
| (941) 318-7612 | wavespestcontrol.com /pest-control-bradenton-fl/ | Bradenton |
| (941) 297-2606 | wavespestcontrol.com /pest-control-sarasota-fl/ | Sarasota |
| (941) 240-2066 | wavespestcontrol.com /pest-control-north-port-fl/ | North Port |
| (941) 283-8194 | bradentonflexterminator.com | Bradenton |
| (941) 326-5011 | bradentonflpestcontrol.com | Bradenton |
| (941) 297-2671 | sarasotaflpestcontrol.com | Sarasota |
| (941) 318-7765 | sarasotaflexterminator.com | Sarasota |
| (941) 213-5203 | palmettoexterminator.com | Palmetto |
| (941) 294-3355 | palmettoflpestcontrol.com | Palmetto |
| (941) 909-8995 | parrishexterminator.com | Parrish |
| (941) 299-8937 | veniceexterminator.com | Venice |
| (941) 258-9109 | portcharlotteflpestcontrol.com | Port Charlotte |
| (941) 253-5279 | parrishpestcontrol.com | Parrish |
| (941) 241-1388 | veniceflpestcontrol.com | Venice |

## Lawn Care — Domain Tracking

| Number | Domain | Area |
|---|---|---|
| (941) 241-3824 | waveslawncare.com | General |
| (941) 304-1850 | bradentonfllawncare.com | Bradenton |
| (941) 269-1692 | sarasotafllawncare.com | Sarasota |
| (941) 207-7456 | parrishfllawncare.com | Parrish |
| (941) 413-1227 | venicelawncare.com | Venice |

## Other

| Number | Purpose |
|---|---|
| (941) 241-2459 | Van Wrap tracking |
| (855) 926-0203 | Toll-free customer chat |

## Notes

- (941) 318-7612 is BOTH the HQ main line AND the Bradenton domain tracker
  for wavespestcontrol.com — same Twilio number, dual-purpose
- E.164 form: +1 + 10 digits (e.g., +19413187612)
- Reply-from rule: outbound to a customer defaults to the number they last
  contacted on this channel; if they've never contacted us, fall back to
  the geographic-market number for their address

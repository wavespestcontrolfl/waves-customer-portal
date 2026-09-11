# Commercial bid quantities and prices

Commercial proposal lines retain four-decimal quantities and unit rates. Each extended line rounds once to cents, and the reviewed amount flows through save, customer documents and the first invoice. Quantities are reviewed operator inputs; no treatment or application rates are recommended by the editor.

Unit controls are behind `GATE_COMMERCIAL_BID_BUILDER`, off by default. Unsetting it hides unused unit selectors and leaves saved units visible without editing. The server refuses unit changes from a stale editor while disabled. Saved decimal prices and units remain honored.

Add building or area line items, choose the quantity and reviewed unit price, save, review, and download the branded proposal. Supported units are square feet, linear feet, acres, pounds, gallons, each, lump sum, hours, days and trips. Fixed validity, private project costs and required original bid forms are separate follow-up changes.

The shared math lives in `shared/proposal-bid.cjs`. Invoice descriptions retain the exact quantity/rate basis, while invoice charges match the reviewed cent-rounded line amount. Loaded edit versions prevent a stale save from overwriting reviewed prices. No migration or dependency is needed.

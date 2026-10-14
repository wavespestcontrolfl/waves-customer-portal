import { describe, expect, it } from "vitest";

import { fastCompleteSheetFor } from "./dispatchCompletionRouting";

// The routing fields of rows from the mobile week list's own payload (GET
// /admin/schedule/week), taken from the real route over a migrated database
// (server/tests/admin-schedule-week-routing-fields.test.js pins that these
// fields equal the day feed's for the same visit), with the gates for the pest
// report flow, the lawn sheet and the Tree & Shrub sheet on. Before the week
// feed carried `propertyId`, none of them left the long form.
const WEEK_ROWS = {
  pest: {
    "status": "confirmed",
    "scheduledDate": "2040-02-01",
    "customerId": "cust-pest",
    "customerName": "Synthetic Fixture",
    "customerPhone": "555-0100",
    "propertyId": "prop-pest",
    "address": "100 Test Lane, Test City, FL 00000",
    "city": "Test City",
    "state": "FL",
    "lat": null,
    "lng": null,
    "checkInTime": null,
    "serviceType": "Pest Control",
    "serviceTypeRaw": "Quarterly Pest Control",
    "completionProfile": {
      "serviceKey": "pest_general_quarterly",
      "serviceName": "Quarterly Pest Control Service",
      "category": "pest_control",
      "billingType": "recurring",
      "completionMode": "service_report",
      "projectType": null,
      "findingsType": null,
      "createsServiceRecord": true,
      "portalVisibility": "customer_portal",
      "portalAttachPolicy": "active_portal_customer",
      "followupPolicy": "none",
      "defaultFollowupDays": null,
      "active": true,
      "notes": "Routine recurring service uses the standard completion/report flow.",
      "projectBacked": false,
      "specialProject": false,
      "requiresProject": false,
      "deliveryMode": "auto_send",
      "companions": []
    },
    "completionProfileLookupFailed": false,
    "findingsSchema": null,
    "linkedProject": null,
    "linkedProjectLookupFailed": false,
    "fastCompleteReportEnabled": true,
    "laneVoiceFillEnabled": false,
    "typedReportFlowEnabled": false,
    "typedVoiceFillEnabled": false,
    "treeShrubFastCompleteEnabled": true,
    "lawnFastCompleteEnabled": true,
    "lawnReserviceFastCompleteEnabled": false,
    "fastCompleteVoiceFillEnabled": false,
    "fastCompleteRecapEnabled": false,
    "noteBoxPhotosEnabled": false,
    "traceVariant": null,
    "traceEligible": true,
    "visitId": null,
    "visitCloseoutEnabled": false,
    "visitCloseoutPacket": null,
    "checkoutInvoiceId": null,
    "inspectionCreditAvailable": false
  },
  lawn: {
    "status": "confirmed",
    "scheduledDate": "2040-02-01",
    "customerId": "cust-lawn",
    "customerName": "Synthetic Fixture",
    "customerPhone": "555-0100",
    "propertyId": "prop-lawn",
    "address": "100 Test Lane, Test City, FL 00000",
    "city": "Test City",
    "state": "FL",
    "lat": null,
    "lng": null,
    "checkInTime": null,
    "serviceType": "Lawn Care",
    "serviceTypeRaw": "Lawn Care",
    "completionProfile": {
      "serviceKey": "lawn_care_recurring",
      "serviceName": "Bi-Monthly Lawn Care Service",
      "category": "lawn_care",
      "billingType": "recurring",
      "completionMode": "service_report",
      "projectType": null,
      "findingsType": null,
      "createsServiceRecord": true,
      "portalVisibility": "customer_portal",
      "portalAttachPolicy": "active_portal_customer",
      "followupPolicy": "none",
      "defaultFollowupDays": null,
      "active": true,
      "notes": "Routine recurring service uses the standard completion/report flow.",
      "projectBacked": false,
      "specialProject": false,
      "requiresProject": false,
      "deliveryMode": "auto_send",
      "companions": []
    },
    "completionProfileLookupFailed": false,
    "findingsSchema": null,
    "linkedProject": null,
    "linkedProjectLookupFailed": false,
    "fastCompleteReportEnabled": true,
    "laneVoiceFillEnabled": false,
    "typedReportFlowEnabled": false,
    "typedVoiceFillEnabled": false,
    "treeShrubFastCompleteEnabled": true,
    "lawnFastCompleteEnabled": true,
    "lawnReserviceFastCompleteEnabled": false,
    "fastCompleteVoiceFillEnabled": false,
    "fastCompleteRecapEnabled": false,
    "noteBoxPhotosEnabled": false,
    "traceVariant": null,
    "traceEligible": true,
    "visitId": null,
    "visitCloseoutEnabled": false,
    "visitCloseoutPacket": null,
    "checkoutInvoiceId": null,
    "inspectionCreditAvailable": false
  },
  treeShrub: {
    "status": "confirmed",
    "scheduledDate": "2040-02-01",
    "customerId": "cust-treeShrub",
    "customerName": "Synthetic Fixture",
    "customerPhone": "555-0100",
    "propertyId": "prop-treeShrub",
    "address": "100 Test Lane, Test City, FL 00000",
    "city": "Test City",
    "state": "FL",
    "lat": null,
    "lng": null,
    "checkInTime": null,
    "serviceType": "Tree & Shrub Care",
    "serviceTypeRaw": "Tree & Shrub Care",
    "completionProfile": {
      "serviceKey": "tree_shrub_quarterly",
      "serviceName": "Quarterly Tree & Shrub Care Service",
      "category": "tree_shrub",
      "billingType": "recurring",
      "completionMode": "service_report",
      "projectType": null,
      "findingsType": "tree_shrub",
      "createsServiceRecord": true,
      "portalVisibility": "customer_portal",
      "portalAttachPolicy": "active_portal_customer",
      "followupPolicy": "none",
      "defaultFollowupDays": null,
      "active": true,
      "notes": "Light (4x) tier uses the same typed tree & shrub completion/report flow as the 6x Standard program. [tree_shrub_quarterly_seed=inserted]",
      "projectBacked": false,
      "specialProject": false,
      "requiresProject": false,
      "deliveryMode": "auto_send",
      "companions": []
    },
    "completionProfileLookupFailed": false,
    "findingsSchema": {
      "type": "tree_shrub",
      "label": "Tree & Shrub Service",
      "schemaVersion": 2,
      "copyMapVersion": 4,
      "fields": [
        {
          "key": "areas_treated",
          "label": "Areas treated",
          "type": "multi_select",
          "section": "Service scope",
          "options": [
            "Front landscape",
            "Back landscape",
            "Side landscapes",
            "Entry landscape",
            "Foundation beds",
            "Pool / lanai landscape",
            "Driveway beds",
            "Hedges / screening plants",
            "Individual tagged plants",
            "Other"
          ],
          "placeholder": null,
          "required": false,
          "requiredUnless": null,
          "internal": false,
          "detail": false,
          "autoFilled": false,
          "pesticideOnly": false,
          "tapOnly": false
        },
        {
          "key": "plant_groups",
          "label": "Plant groups serviced",
          "type": "multi_select",
          "section": "Service scope",
          "options": [
            "Palms",
            "Shrubs",
            "Ornamentals",
            "Hedges",
            "Small trees",
            "Flowering plants",
            "Groundcover beds",
            "Other"
          ],
          "placeholder": null,
          "required": true,
          "requiredUnless": null,
          "internal": false,
          "detail": false,
          "autoFilled": false,
          "pesticideOnly": false,
          "tapOnly": false
        },
        {
          "key": "landscape_condition",
          "label": "Overall landscape condition",
          "type": "select",
          "section": "Service scope",
          "options": [
            "Excellent",
            "Good",
            "Fair",
            "Poor",
            "Declining",
            "Recovering"
          ],
          "placeholder": null,
          "required": true,
          "requiredUnless": null,
          "internal": false,
          "detail": false,
          "autoFilled": false,
          "pesticideOnly": false,
          "tapOnly": false
        },
        {
          "key": "treatments_completed",
          "label": "Treatment completed",
          "type": "multi_select",
          "section": "Treatments",
          "options": [
            "Fertilizer",
            "Palm fertilizer",
            "Micronutrients",
            "Insect treatment",
            "Disease / fungicide treatment",
            "Horticultural oil",
            "Soil drench",
            "Foliar treatment",
            "Pre-emergent bed treatment",
            "Weed spot treatment",
            "Soil amendment / acidifier",
            "Inspection only"
          ],
          "placeholder": null,
          "required": false,
          "requiredUnless": null,
          "internal": false,
          "detail": false,
          "autoFilled": true,
          "pesticideOnly": false,
          "tapOnly": false
        },
        {
          "key": "bed_sqft_serviced",
          "label": "Ornamental bed area serviced (sq ft)",
          "type": "measurement",
          "section": "Property measurements",
          "options": null,
          "placeholder": "e.g. 2400",
          "required": false,
          "requiredUnless": null,
          "internal": true,
          "detail": true,
          "autoFilled": false,
          "pesticideOnly": false,
          "tapOnly": false
        },
        {
          "key": "palm_count_total",
          "label": "Palms on property",
          "type": "count",
          "section": "Property measurements",
          "options": null,
          "placeholder": null,
          "required": false,
          "requiredUnless": null,
          "internal": true,
          "detail": true,
          "autoFilled": false,
          "pesticideOnly": false,
          "tapOnly": false
        },
        {
          "key": "tree_count_total",
          "label": "Trees on property (non-palm)",
          "type": "count",
          "section": "Property measurements",
          "options": null,
          "placeholder": null,
          "required": false,
          "requiredUnless": null,
          "internal": true,
          "detail": true,
          "autoFilled": false,
          "pesticideOnly": false,
          "tapOnly": false
        },
        {
          "key": "shrub_density",
          "label": "Shrub density",
          "type": "select",
          "section": "Property measurements",
          "options": [
            "Light",
            "Moderate",
            "Heavy"
          ],
          "placeholder": null,
          "required": false,
          "requiredUnless": null,
          "internal": true,
          "detail": true,
          "autoFilled": false,
          "pesticideOnly": false,
          "tapOnly": false
        },
        {
          "key": "access_difficulty",
          "label": "Access difficulty",
          "type": "select",
          "section": "Property measurements",
          "options": [
            "Easy",
            "Moderate",
            "Difficult"
          ],
          "placeholder": null,
          "required": false,
          "requiredUnless": null,
          "internal": true,
          "detail": true,
          "autoFilled": false,
          "pesticideOnly": false,
          "tapOnly": false
        },
        {
          "key": "pollinator_status",
          "label": "Flowering / pollinator status",
          "type": "select",
          "section": "Compliance",
          "options": [
            "No blooms or no bees",
            "Blooming \u2014 no bees active",
            "Blooming \u2014 bees active",
            "No insecticide applied"
          ],
          "placeholder": null,
          "required": false,
          "requiredUnless": null,
          "internal": true,
          "detail": false,
          "autoFilled": false,
          "pesticideOnly": true,
          "tapOnly": false
        },
        {
          "key": "irac_frac_logged",
          "label": "IRAC / FRAC rotation checked & logged",
          "type": "select",
          "section": "Compliance",
          "options": [
            "Yes",
            "No"
          ],
          "placeholder": null,
          "required": false,
          "requiredUnless": null,
          "internal": true,
          "detail": false,
          "autoFilled": false,
          "pesticideOnly": true,
          "tapOnly": false
        },
        {
          "key": "customer_recommendations",
          "label": "Customer recommendations",
          "type": "multi_select",
          "section": "Recommendations",
          "options": [
            "Adjust irrigation",
            "Avoid over-pruning",
            "Remove dead plant material",
            "Trim away from structure",
            "Keep mulch off trunks / stems",
            "Monitor decline",
            "Replace severely declining plant",
            "Approve injection",
            "Improve drainage",
            "Continue program"
          ],
          "placeholder": null,
          "required": false,
          "requiredUnless": null,
          "internal": false,
          "detail": false,
          "autoFilled": false,
          "pesticideOnly": false,
          "tapOnly": false
        }
      ],
      "photoCategories": [
        "palm",
        "shrub",
        "bed",
        "disease",
        "pest_activity",
        "treatment_area",
        "before",
        "after",
        "other"
      ],
      "requiredFields": [
        "plant_groups",
        "landscape_condition"
      ],
      "activity": null
    },
    "linkedProject": null,
    "linkedProjectLookupFailed": false,
    "fastCompleteReportEnabled": false,
    "laneVoiceFillEnabled": false,
    "typedReportFlowEnabled": false,
    "typedVoiceFillEnabled": false,
    "treeShrubFastCompleteEnabled": true,
    "lawnFastCompleteEnabled": true,
    "lawnReserviceFastCompleteEnabled": false,
    "fastCompleteVoiceFillEnabled": false,
    "fastCompleteRecapEnabled": false,
    "noteBoxPhotosEnabled": false,
    "traceVariant": null,
    "traceEligible": true,
    "visitId": null,
    "visitCloseoutEnabled": false,
    "visitCloseoutPacket": null,
    "checkoutInvoiceId": null,
    "inspectionCreditAvailable": false
  },
  wdo: {
    "status": "confirmed",
    "scheduledDate": "2040-02-01",
    "customerId": "cust-wdo",
    "customerName": "Synthetic Fixture",
    "customerPhone": "555-0100",
    "propertyId": "prop-wdo",
    "address": "100 Test Lane, Test City, FL 00000",
    "city": "Test City",
    "state": "FL",
    "lat": null,
    "lng": null,
    "checkInTime": null,
    "serviceType": "WDO Inspection",
    "serviceTypeRaw": "WDO Inspection",
    "completionProfile": {
      "serviceKey": "wdo_inspection",
      "serviceName": "WDO Inspection Service",
      "category": "inspection",
      "billingType": "one_time",
      "completionMode": "special_project",
      "projectType": "wdo_inspection",
      "findingsType": null,
      "createsServiceRecord": true,
      "portalVisibility": "token_only",
      "portalAttachPolicy": "recurring_customer",
      "followupPolicy": "none",
      "defaultFollowupDays": null,
      "active": true,
      "notes": "Formal WDO report. Keep out of routine service-report surfaces.",
      "projectBacked": true,
      "specialProject": true,
      "requiresProject": true,
      "deliveryMode": "auto_send",
      "companions": []
    },
    "completionProfileLookupFailed": false,
    "findingsSchema": null,
    "linkedProject": null,
    "linkedProjectLookupFailed": false,
    "fastCompleteReportEnabled": true,
    "laneVoiceFillEnabled": false,
    "typedReportFlowEnabled": false,
    "typedVoiceFillEnabled": false,
    "treeShrubFastCompleteEnabled": true,
    "lawnFastCompleteEnabled": true,
    "lawnReserviceFastCompleteEnabled": false,
    "fastCompleteVoiceFillEnabled": false,
    "fastCompleteRecapEnabled": false,
    "noteBoxPhotosEnabled": false,
    "traceVariant": null,
    "traceEligible": true,
    "visitId": null,
    "visitCloseoutEnabled": false,
    "visitCloseoutPacket": null,
    "checkoutInvoiceId": null,
    "inspectionCreditAvailable": false
  },
};

describe("a visit opened from the mobile week list opens the sheet the day view gives it", () => {
  it.each([
    ["a regular pest visit", "pest", "pest"],
    ["a lawn visit", "lawn", "lawn"],
    ["a tree and shrub visit", "treeShrub", "tree_shrub"],
  ])("%s opens the %s sheet", (_label, kind, sheet) => {
    expect(fastCompleteSheetFor(WEEK_ROWS[kind])).toBe(sheet);
  });

  it("a project-backed visit (a WDO inspection) stays on the full form", () => {
    expect(fastCompleteSheetFor(WEEK_ROWS.wdo)).toBeNull();
  });

  it("a visit with an invoice from the payment flow, or a closed visit, stays on the full form", () => {
    expect(fastCompleteSheetFor({ ...WEEK_ROWS.pest, checkoutInvoiceId: "inv-fixture" })).toBeNull();
    expect(fastCompleteSheetFor({ ...WEEK_ROWS.lawn, completionInvoiceAlreadySent: true })).toBeNull();
    expect(fastCompleteSheetFor({ ...WEEK_ROWS.treeShrub, status: "completed" })).toBeNull();
  });

  it("a failed project lookup and a gate that is off stay on the full form", () => {
    expect(fastCompleteSheetFor({ ...WEEK_ROWS.pest, linkedProjectLookupFailed: true })).toBeNull();
    expect(fastCompleteSheetFor({ ...WEEK_ROWS.pest, fastCompleteReportEnabled: false })).toBeNull();
    expect(fastCompleteSheetFor({ ...WEEK_ROWS.lawn, lawnFastCompleteEnabled: false })).toBeNull();
  });

  it("a week row with no propertyId key still stays on the full form (the premise check keeps its guard)", () => {
    for (const kind of ["pest", "lawn", "treeShrub"]) {
      const { propertyId: _dropped, ...noKey } = WEEK_ROWS[kind];
      expect(fastCompleteSheetFor(noKey)).toBeNull();
    }
  });

  it("a visit never stamped with a property (propertyId null) still opens its sheet", () => {
    expect(fastCompleteSheetFor({ ...WEEK_ROWS.pest, propertyId: null })).toBe("pest");
  });
});

// Bid kit pill for a Bid Desk checklist line: the kit's own status rule, worst of several papers, the reference count,
// and the template wording for the notarized statement. Synthetic data only.
import { describe, expect, it } from "vitest";
import { buildKitIndex, pillForLine } from "./bidChecklistKit";

const TODAY = "2026-10-25";
let n = 0;
const doc = (item_key, over = {}) => ({ id: `k${++n}`, kind: "document", item_key, label: null, value: null, file: { name: "x.pdf" }, expires_on: null, attested_at: "2026-10-01T12:00:00Z", archived_at: null, ...over });
const fact = (item_key, over = {}) => ({ id: `k${++n}`, kind: "fact", item_key, value: "SAMPLE123", attested_at: "2026-10-01T12:00:00Z", archived_at: null, ...over });
const ref = (over = {}) => ({ id: `k${++n}`, kind: "reference", item_key: "reference", value: null, details: { entity: "Sample County" }, permission_on: "2026-09-01", attested_at: "2026-10-01T12:00:00Z", archived_at: null, ...over });
const index = (items) => buildKitIndex({ today: TODAY, items });

describe("buildKitIndex", () => {
  it("is null for an unusable reply and skips archived rows and rows of the wrong kind", () => {
    expect(buildKitIndex(null)).toBeNull();
    expect(buildKitIndex({ today: TODAY })).toBeNull();
    const idx = index([doc("w9", { archived_at: "2026-10-02T00:00:00Z" }), fact("w9"), doc("nope")]);
    expect(idx.byKey).toEqual({});
  });
});

describe("pillForLine", () => {
  it("shows nothing for an unmapped line, a typed line, or an unloaded kit", () => {
    const idx = index([]);
    expect(pillForLine("base.signer", idx)).toBeNull();
    expect(pillForLine("rfp.narrative", idx)).toBeNull();
    expect(pillForLine(null, idx)).toBeNull();
    expect(pillForLine("itb.business_license", null)).toBeNull();
  });

  it("signed off paper: on file, signed off, linked to the kit item", () => {
    const row = doc("business_license_copy", { expires_on: "2027-06-30" });
    const pill = pillForLine("itb.business_license", index([row]));
    expect(pill.text).toBe("Kit: on file, signed off");
    expect(pill.to).toBe(`/admin/bid-kit?item=${row.id}`);
    expect(pill.tone).toBe("strong");
  });

  it("a paper not signed off yet", () => {
    const pill = pillForLine("itb.employee_ids", index([doc("employee_id_cards", { expires_on: "2027-03-01", attested_at: null })]));
    expect(pill.text).toBe("Kit: on file, not signed off");
  });

  it("an expiring paper shows the days left", () => {
    const pill = pillForLine("itb.operator_certificate", index([doc("cpco_certificate", { expires_on: "2026-11-04" })]));
    expect(pill.text).toBe("Kit: expires in 10 days");
    expect(pillForLine("itb.operator_certificate", index([doc("cpco_certificate", { expires_on: "2026-10-26" })])).text).toBe("Kit: expires in 1 day");
    expect(pillForLine("itb.operator_certificate", index([doc("cpco_certificate", { expires_on: TODAY })])).text).toBe("Kit: expires today");
  });

  it("an expired paper", () => {
    const pill = pillForLine("itb.operator_certificate", index([doc("cpco_certificate", { expires_on: "2026-10-01" })]));
    expect(pill.text).toBe("Kit: expired");
    expect(pill.tone).toBe("alert");
  });

  it("a paper with no kit row, or a row with no file, is missing and links to the kit page", () => {
    expect(pillForLine("itb.product_list", index([]))).toMatchObject({ text: "Kit: missing", to: "/admin/bid-kit" });
    const noFile = doc("product_list", { file: null });
    expect(pillForLine("itb.product_list", index([noFile]))).toMatchObject({ text: "Kit: missing", to: `/admin/bid-kit?item=${noFile.id}` });
  });

  it("a document that expires but has no expiry date asks for the date", () => {
    expect(pillForLine("itb.business_license", index([doc("business_license_copy")])).text).toBe("Kit: on file, add expiry date");
  });

  it("several papers: the worst status wins and the title names every paper", () => {
    const idx = index([
      doc("business_license_copy", { expires_on: "2027-06-30" }),
      doc("cpco_certificate", { expires_on: "2027-06-30" }),
      doc("business_tax_receipt", { expires_on: "2026-10-01" }),
      doc("sunbiz_status"),
    ]);
    const pill = pillForLine("base.licenses", idx);
    expect(pill.text).toBe("Kit: expired");
    expect(pill.title).toContain("FDACS business license copy (Ready)");
    expect(pill.title).toContain("Local business tax receipt (Expired)");
    expect(pill.title).toContain("Sunbiz active-status printout (Ready)");
    expect(pillForLine("base.licenses", index([doc("business_license_copy", { expires_on: "2027-06-30" })])).text).toBe("Kit: missing");
    expect(pillForLine("base.licenses", index([doc("business_license_copy", { expires_on: "2027-06-30" })])).title).toContain("Sunbiz active-status printout (Missing)");
  });

  it("several papers with one missing: missing beats expired", () => {
    const idx = index([doc("everify"), doc("drug_free_policy", { file: null })]);
    expect(pillForLine("base.forms", idx).text).toBe("Kit: missing");
    expect(pillForLine("base.forms", index([doc("everify"), doc("drug_free_policy")])).text).toBe("Kit: on file, signed off");
  });

  it("the notarized statement is a template, never done", () => {
    const row = doc("cpco_fulltime_statement");
    const pill = pillForLine("itb.operator_statement", index([row]));
    expect(pill.text).toBe("Kit: template on file");
    expect(pill.text).not.toMatch(/signed off|done/i);
    expect(pill.to).toBe(`/admin/bid-kit?item=${row.id}`);
    expect(pillForLine("itb.operator_statement", index([doc("cpco_fulltime_statement", { attested_at: null })])).text).toBe("Kit: template on file");
    expect(pillForLine("itb.operator_statement", index([])).text).toBe("Kit: missing");
  });

  it("references show how many ready references of three", () => {
    const two = index([ref(), ref(), ref({ permission_on: null }), ref({ archived_at: "2026-10-02T00:00:00Z" })]);
    for (const line of ["quote.references", "itb.references_form", "rfp.reference_surveys", "stop.reference_rules", "federal.past_performance"]) {
      expect(pillForLine(line, two)).toMatchObject({ text: "Kit: 2 of 3 references", tone: "warn", to: "/admin/bid-kit" });
    }
    expect(pillForLine("quote.references", index([ref(), ref(), ref(), ref()])).text).toBe("Kit: 4 of 3 references");
    expect(pillForLine("quote.references", index([ref(), ref(), ref()])).tone).toBe("strong");
    expect(pillForLine("quote.references", index([])).text).toBe("Kit: 0 of 3 references");
    expect(pillForLine("quote.references", index([])).tone).toBe("alert");
  });

  it("a reference that is about to expire still counts; one past its date does not", () => {
    const idx = index([ref({ expires_on: "2026-10-30" }), ref({ expires_on: "2026-10-01" })]);
    expect(pillForLine("quote.references", idx).text).toBe("Kit: 1 of 3 references");
  });

  it("reps and certs read two facts", () => {
    expect(pillForLine("federal.reps_certs", index([fact("sam_uei"), fact("cage_code")])).text).toBe("Kit: on file, signed off");
    expect(pillForLine("federal.reps_certs", index([fact("sam_uei")])).text).toBe("Kit: missing");
  });
});

import { describe, it, expect } from "vitest";
import { formatMixAmount, mixTable } from "./protocol-mix-amounts";
import protocols from "../../../server/config/protocols.json";

describe("protocol mix amounts", () => {
  it("multiplies one per-gallon rate into each sprayer", () => {
    const { rows, columns } = mixTable([
      { product: "LESCO Crosscheck Plus", where: "Outside", perGallon: { amount: 0.625, unit: "fl oz" }, sprayers: ["bg_1_gal", "flowzone_4_gal"] },
    ]);
    expect(columns.map((c) => c.key)).toEqual(["bg_1_gal", "flowzone_4_gal"]);
    expect(rows[0].amounts.bg_1_gal).toBe("0.625 fl oz (18.5 mL)");
    expect(rows[0].amounts.flowzone_4_gal).toBe("2.5 fl oz");
  });

  it("shows a label band and large units", () => {
    expect(formatMixAmount(10, "g", 30)).toBe("10 to 30 g");
    expect(formatMixAmount(500, "g", 1500)).toBe("0.5 to 1.5 kg");
    expect(formatMixAmount(0.66, "fl oz")).toBe("0.66 fl oz (19.5 mL)");
    expect(formatMixAmount(1000, "g")).toBe("1 kg");
    expect(formatMixAmount(80, "fl oz")).toBe("80 fl oz");
    expect(formatMixAmount(6400, "fl oz")).toBe("50 gal");
  });

  it("gives a placement row no tank amount", () => {
    const { rows, columns } = mixTable([{ product: "Gel", where: "Hinges", dose: "0.5 g per spot" }]);
    expect(columns).toEqual([]);
    expect(rows[0].amounts).toEqual({});
  });

  it("pins the live card rates", () => {
    const visit = (program, num) => protocols[program].visits.find((v) => v.visit === num);
    const amounts = (program, num, product) =>
      mixTable(visit(program, num).mixRates).rows.find((row) => row.product === product).amounts;
    expect(amounts("pest", 1, "LESCO Crosscheck Plus").flowzone_4_gal).toBe("2.5 fl oz");
    expect(amounts("pest", 1, "Taurus SC").flowzone_4_gal).toBe("1.6 fl oz");
    expect(amounts("pest", 1, "Atticus Antapex WSG").bg_1_gal).toBe("10 g");
    expect(amounts("cockroach", 1, "Tekko Pro IGR").flowzone_4_gal).toBe("8 fl oz");
    expect(amounts("flea", 1, "Tekko Pro IGR").flowzone_4_gal).toBe("2.64 fl oz");
    expect(amounts("mosquito", 1, "Suspend Polyzone").flowzone_4_gal).toBe("4.4 fl oz");
    expect(amounts("mosquito", 1, "Suspend Polyzone").bg_1_gal).toBeUndefined();
    expect(amounts("flea", 1, "Tekko Pro IGR").bg_1_gal).toBe("0.66 fl oz (19.5 mL)");
    expect(amounts("termite", 3, "Termidor SC").rig_100_gal).toBe("80 fl oz");
    expect(amounts("termite", 3, "Termidor SC").bg_1_gal).toBe("0.8 fl oz (23.7 mL)");
  });
});

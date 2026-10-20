import { describe, expect, it } from "vitest";
import {
  defaultSizeChart,
  tieneAjuste,
  FABRIC_PUNTO,
  recommendSize,
  sortSizes,
} from "../src/index.js";
import type { Measurements } from "../src/morphology.js";

describe("defaultSizeChart", () => {
  it("gradúa las tallas de letra alrededor de M", () => {
    const chart = defaultSizeChart("sweater", ["S", "M", "L"]);
    expect(chart.M?.chest).toBe(104); // base
    expect(chart.S?.chest).toBe(98); //  -6
    expect(chart.L?.chest).toBe(110); // +6
  });

  it("solo incluye las tallas pedidas (las que hay en stock)", () => {
    const chart = defaultSizeChart("sweater", ["M", "XL"]);
    expect(Object.keys(chart).sort()).toEqual(["M", "XL"]);
  });

  it("acepta O/S como talla única ancha", () => {
    const chart = defaultSizeChart("cardigan", ["O/S"]);
    expect(chart["O/S"]).toBeDefined();
    // talla única = más generosa que la M.
    expect(chart["O/S"]!.chest!).toBeGreaterThan(defaultSizeChart("cardigan", ["M"]).M!.chest!);
  });

  it("omite tallas desconocidas como OTRA", () => {
    const chart = defaultSizeChart("sweater", ["M", "OTRA"]);
    expect(Object.keys(chart)).toEqual(["M"]);
  });

  it("un pantalón no declara pecho; una falda no declara manga", () => {
    expect(defaultSizeChart("pants", ["M"]).M?.chest).toBeUndefined();
    expect(defaultSizeChart("pants", ["M"]).M?.inseam).toBeGreaterThan(0);
    expect(defaultSizeChart("skirt", ["M"]).M?.sleeve).toBeUndefined();
  });

  it("el chal no tiene ajuste significativo", () => {
    expect(tieneAjuste("shawl")).toBe(false);
    expect(tieneAjuste("sweater")).toBe(true);
  });

  it("integra con recommendSize: un cuerpo medio entra en la M de un suéter", () => {
    const body: Measurements = { bust: 92, waist: 76, hip: 98, shoulder: 38 };
    const chart = defaultSizeChart("sweater", ["S", "M", "L"]);
    const rec = recommendSize(body, chart, FABRIC_PUNTO);
    expect(rec.best).not.toBeNull();
    expect(sortSizes(rec.all.map((f) => f.size))).toEqual(["S", "M", "L"]);
  });
});

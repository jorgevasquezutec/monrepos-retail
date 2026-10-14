import { describe, it, expect } from "vitest";
import { rgbToHsl, hexToRgb, rgbToHex, colorDistance, averageRgb } from "../src/color.js";

describe("conversiones de color", () => {
  it("convierte blanco y negro a HSL", () => {
    expect(rgbToHsl({ r: 255, g: 255, b: 255 })).toMatchObject({ l: 1 });
    expect(rgbToHsl({ r: 0, g: 0, b: 0 })).toMatchObject({ l: 0 });
  });

  it("rojo puro tiene hue 0 y saturación máxima", () => {
    const hsl = rgbToHsl({ r: 255, g: 0, b: 0 });
    expect(hsl.h).toBeCloseTo(0);
    expect(hsl.s).toBeCloseTo(1);
    expect(hsl.l).toBeCloseTo(0.5);
  });

  it("verde puro tiene hue 120", () => {
    expect(rgbToHsl({ r: 0, g: 255, b: 0 }).h).toBeCloseTo(120);
  });

  it("hexToRgb y rgbToHex son inversos", () => {
    expect(rgbToHex(hexToRgb("#3fb6a8"))).toBe("#3fb6a8");
  });

  it("hexToRgb rechaza formatos inválidos", () => {
    expect(() => hexToRgb("#zzz")).toThrow();
    expect(() => hexToRgb("123")).toThrow();
  });

  it("colorDistance es 0 para colores idénticos y positivo si difieren", () => {
    const c = { r: 100, g: 120, b: 140 };
    expect(colorDistance(c, c)).toBe(0);
    expect(colorDistance(c, { r: 0, g: 0, b: 0 })).toBeGreaterThan(0);
  });

  it("averageRgb promedia correctamente", () => {
    expect(averageRgb([
      { r: 0, g: 0, b: 0 },
      { r: 100, g: 200, b: 40 },
    ])).toEqual({ r: 50, g: 100, b: 20 });
  });
});

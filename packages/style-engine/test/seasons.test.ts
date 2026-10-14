import { describe, it, expect } from "vitest";
import { analyzeSeason, skinToAxes, SEASONS } from "../src/seasons.js";

describe("colorimetría / 12 estaciones", () => {
  it("una piel clara y dorada da subtono cálido", () => {
    const { subtono, axes } = analyzeSeason({ r: 240, g: 205, b: 160 });
    expect(axes.temperature).toBeGreaterThan(0);
    expect(subtono).toBe("cálido");
  });

  it("una piel rosada/clara da subtono frío", () => {
    const { subtono, axes } = analyzeSeason({ r: 232, g: 200, b: 205 });
    expect(axes.temperature).toBeLessThan(0);
    expect(subtono).toBe("frío");
  });

  it("una piel oscura profunda tiene value negativo (profundo)", () => {
    const { axes } = analyzeSeason({ r: 90, g: 60, b: 45 });
    expect(axes.value).toBeLessThan(0);
  });

  it("una piel muy clara tiene value positivo (claro)", () => {
    const { axes } = analyzeSeason({ r: 245, g: 225, b: 210 });
    expect(axes.value).toBeGreaterThan(0);
  });

  it("siempre devuelve una de las 12 estaciones con las 12 en el ranking", () => {
    const res = analyzeSeason({ r: 200, g: 170, b: 150 });
    expect(Object.keys(SEASONS)).toContain(res.season.id);
    expect(res.ranking).toHaveLength(12);
  });

  it("la confianza está en [0,1]", () => {
    const res = analyzeSeason({ r: 200, g: 170, b: 150 });
    expect(res.confianza).toBeGreaterThanOrEqual(0);
    expect(res.confianza).toBeLessThanOrEqual(1);
  });

  it("cada estación tiene una paleta no vacía", () => {
    for (const s of Object.values(SEASONS)) {
      expect(s.paleta.length).toBeGreaterThan(0);
      for (const hex of s.paleta) expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("skinToAxes mantiene los ejes dentro de [-1,1]", () => {
    for (const skin of [
      { r: 255, g: 255, b: 255 },
      { r: 0, g: 0, b: 0 },
      { r: 210, g: 150, b: 120 },
    ]) {
      const a = skinToAxes(skin);
      for (const v of [a.temperature, a.value, a.chroma]) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

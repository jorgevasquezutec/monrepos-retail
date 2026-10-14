import { describe, it, expect } from "vitest";
import { classifyBody } from "../src/morphology.js";

describe("morfología corporal", () => {
  it("reloj de arena: busto ≈ cadera con cintura marcada", () => {
    expect(classifyBody({ bust: 92, waist: 66, hip: 94 }).shape).toBe("hourglass");
  });

  it("pera: cadera claramente más ancha que el busto", () => {
    expect(classifyBody({ bust: 88, waist: 72, hip: 104 }).shape).toBe("pear");
  });

  it("triángulo invertido: hombros/busto más anchos que la cadera", () => {
    expect(classifyBody({ bust: 104, waist: 80, hip: 90 }).shape).toBe("inverted-triangle");
  });

  it("rectángulo: medidas similares sin cintura marcada", () => {
    expect(classifyBody({ bust: 92, waist: 82, hip: 93 }).shape).toBe("rectangle");
  });

  it("manzana: la cintura es la medida mayor", () => {
    expect(classifyBody({ bust: 96, waist: 100, hip: 94 }).shape).toBe("apple");
  });

  it("devuelve consejos de silueta no vacíos", () => {
    const info = classifyBody({ bust: 92, waist: 66, hip: 94 });
    expect(info.favorece.length).toBeGreaterThan(0);
    expect(info.objetivo).toBeTruthy();
  });

  it("usa el hombro cuando se proporciona", () => {
    // Hombros anchos aunque el busto sea moderado => triángulo invertido.
    expect(classifyBody({ bust: 90, waist: 78, hip: 90, shoulder: 106 }).shape).toBe("inverted-triangle");
  });
});

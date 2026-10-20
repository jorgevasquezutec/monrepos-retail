import { describe, expect, it } from "vitest";
import {
  computeFit,
  parseSizeChartCSV,
  recommendSize,
  sizeChartToCSV,
  FABRIC_PLANO,
  type Fabric,
  type SizeChart,
} from "../src/sizing.js";
import type { Measurements } from "../src/morphology.js";

const PUNTO: Fabric = { tipo: "punto", stretchPct: 8 };

// Camiseta de punto (contornos de prenda terminada).
const TEE: SizeChart = {
  S: { chest: 96, waist: 92 },
  M: { chest: 102, waist: 98 },
  L: { chest: 108, waist: 104 },
};

describe("parseSizeChartCSV · fábrica", () => {
  it("acepta cabeceras en español (pecho/cintura/cadera/largo/manga)", () => {
    const csv = "talla,pecho,cintura,cadera,largo,manga\nM,104,100,106,62,58";
    const { chart, errors } = parseSizeChartCSV(csv);
    expect(errors).toEqual([]);
    expect(chart.M).toEqual({ chest: 104, waist: 100, hip: 106, length: 62, sleeve: 58 });
  });

  it("acepta talla única O/S y sus variantes, normalizando a O/S", () => {
    const csv = "talla,pecho\nOS,120";
    const { chart } = parseSizeChartCSV(csv);
    expect(chart["O/S"]).toEqual({ chest: 120 });
  });

  it("ignora columnas desconocidas como 'tolerancia' sin romper", () => {
    const csv = "talla,pecho,tolerancia\nM,104,1.5";
    const { chart, errors } = parseSizeChartCSV(csv);
    expect(errors).toEqual([]);
    expect(chart.M).toEqual({ chest: 104 });
  });
});

describe("computeFit", () => {
  it("solo evalúa zonas presentes en prenda y cuerpo", () => {
    const body: Measurements = { bust: 94, waist: 82, hip: 96 };
    const fit = computeFit(body, TEE.M!, PUNTO, "M");
    // La prenda no declara cadera → no aparece esa zona.
    expect(fit.zones.map((z) => z.zone).sort()).toEqual(["chest", "waist"]);
  });

  it("calcula holgura positiva cuando la prenda es mayor que el cuerpo", () => {
    const body: Measurements = { bust: 94, waist: 82, hip: 96 };
    const chest = computeFit(body, TEE.M!, PUNTO, "M").zones.find((z) => z.zone === "chest")!;
    expect(chest.easeCm).toBeCloseTo(8, 5); // 102 − 94
    expect(chest.state).toBe("regular");
  });

  it("marca 'no-entra' cuando el cuerpo supera el estiramiento del tejido", () => {
    const body: Measurements = { bust: 120, waist: 110, hip: 110 };
    // Plano rígido: 96 * 1.0 = 96 < 120 → no entra.
    const rigid = computeFit(body, TEE.S!, FABRIC_PLANO, "S");
    expect(rigid.fits).toBe(false);
    expect(rigid.zones.find((z) => z.zone === "chest")!.state).toBe("no-entra");
  });

  it("el tejido elástico permite algo de holgura negativa (ajustada, no 'no-entra')", () => {
    const body: Measurements = { bust: 100, waist: 90, hip: 96 };
    // 96 * 1.08 = 103.7 ≥ 100 → entra, pero apretada.
    const knit = computeFit(body, TEE.S!, PUNTO, "S");
    expect(knit.fits).toBe(true);
    expect(["muy-ajustada", "ajustada"]).toContain(
      knit.zones.find((z) => z.zone === "chest")!.state,
    );
  });
});

describe("recommendSize", () => {
  it("elige la talla con holgura más cercana a la ideal", () => {
    const body: Measurements = { bust: 96, waist: 90, hip: 96 };
    const rec = recommendSize(body, TEE, PUNTO);
    expect(rec.best).toBe("M"); // S iría justa, L quedaría holgada
    expect(rec.all).toHaveLength(3);
  });

  it("sube de talla para un cuerpo grande y descarta las que no entran", () => {
    const body: Measurements = { bust: 106, waist: 100, hip: 104 };
    const rec = recommendSize(body, TEE, FABRIC_PLANO);
    expect(rec.best).toBe("L");
  });

  it("devuelve best=null si ninguna talla entra", () => {
    const body: Measurements = { bust: 140, waist: 130, hip: 140 };
    const rec = recommendSize(body, TEE, FABRIC_PLANO);
    expect(rec.best).toBeNull();
  });
});

describe("parseSizeChartCSV", () => {
  it("parsea una tabla válida ignorando columnas desconocidas", () => {
    const { chart, errors } = parseSizeChartCSV(
      "talla,chest,waist,color\nS,96,84,rojo\nM,102,90,azul\n",
    );
    expect(errors).toEqual([]);
    expect(chart.S).toEqual({ chest: 96, waist: 84 });
    expect(chart.M).toEqual({ chest: 102, waist: 90 });
  });

  it("reporta tallas y valores inválidos sin abortar", () => {
    const { chart, errors } = parseSizeChartCSV(
      "talla,chest\nS,96\nZZ,100\nL,abc\n",
    );
    expect(chart.S).toEqual({ chest: 96 });
    expect(chart.L).toBeUndefined(); // 'abc' no es número → fila sin medidas
    // 3 avisos: talla ZZ desconocida + celda 'abc' inválida + fila L sin medidas.
    expect(errors.length).toBe(3);
    expect(errors.some((e) => e.includes("ZZ"))).toBe(true);
    expect(errors.some((e) => e.includes("L"))).toBe(true);
  });

  it("exige la columna 'talla'", () => {
    const { errors } = parseSizeChartCSV("chest,waist\n96,84\n");
    expect(errors[0]).toMatch(/talla/);
  });

  it("ida y vuelta CSV → chart → CSV es estable", () => {
    const csv = "talla,chest,waist\nS,96,84\nM,102,90";
    const { chart } = parseSizeChartCSV(csv);
    expect(sizeChartToCSV(chart)).toBe(csv);
  });
});

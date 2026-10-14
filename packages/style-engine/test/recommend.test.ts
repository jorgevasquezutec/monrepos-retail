import { describe, it, expect } from "vitest";
import { recommend } from "../src/recommend.js";
import { SEASONS } from "../src/seasons.js";
import { classifyBody } from "../src/morphology.js";
import { DEMO_CATALOG } from "../src/catalog.js";

describe("recomendador", () => {
  const shape = classifyBody({ bust: 88, waist: 72, hip: 104 }); // pera
  const season = SEASONS["true-autumn"];

  it("puntúa todas las prendas y las ordena de mayor a menor", () => {
    const res = recommend({ season, shape, catalog: DEMO_CATALOG });
    expect(res).toHaveLength(DEMO_CATALOG.length);
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1].score).toBeGreaterThanOrEqual(res[i].score);
    }
  });

  it("todas las puntuaciones están en [0,1]", () => {
    for (const r of recommend({ season, shape, catalog: DEMO_CATALOG })) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("prioriza siluetas favorables para la figura pera", () => {
    // Con todo el peso en la silueta, la mejor prenda debe favorecer a la pera.
    const res = recommend({ season, shape, catalog: DEMO_CATALOG, pesoColor: 0 });
    const mejor = res[0].garment;
    const favorece = mejor.siluetas.some((s) => shape.favorece.includes(s));
    expect(favorece).toBe(true);
  });

  it("un color de la propia paleta obtiene colorScore alto", () => {
    const catalog = [{ id: "x", nombre: "Test", categoria: "top" as const, genero: "unisex" as const, color: season.paleta[0], siluetas: [], precio: 10 }];
    const [r] = recommend({ season, shape, catalog, pesoColor: 1 });
    expect(r.colorScore).toBeGreaterThan(0.9);
  });

  it("los motivos usan la figura real del usuario y vocabulario acorde al sexo", () => {
    const fem = recommend({ season, shape, catalog: DEMO_CATALOG, genero: "female", pesoColor: 0 });
    const motivoF = fem.flatMap((r) => r.motivos).find((m) => m.startsWith("Silueta favorable"));
    expect(motivoF).toContain(shape.nombre);

    const rect = classifyBody({ bust: 96, waist: 90, hip: 96 });
    const male = recommend({ season, shape: rect, catalog: DEMO_CATALOG, genero: "male", pesoColor: 0 });
    const motivosM = male.flatMap((r) => r.motivos).filter((m) => m.startsWith("Silueta favorable"));
    for (const m of motivosM) {
      expect(m).toContain("complexión recta");
      expect(m).not.toMatch(/Pera|Reloj de arena|Manzana/);
    }
  });
});

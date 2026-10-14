/**
 * Cliente del servicio generador de cuerpo (tools/serve.py en Docker).
 * Envía las medidas y recibe un GLB, que se expone como object URL para
 * cargarlo en el visor. Cada combinación de medidas → su propio cuerpo.
 */

import type { Measurements } from "@retail/style-engine";

// 127.0.0.1 (IPv4) en vez de localhost: algunos navegadores resuelven localhost
// a ::1 (IPv6) y la conexión al contenedor puede fallar de forma intermitente.
const SERVICE_URL =
  (import.meta.env.VITE_AVATAR_SERVICE as string | undefined) ?? "http://127.0.0.1:8123";

export type HairStyle = "auto" | "none" | "short" | "bob" | "long" | "ponytail" | "braids" | "afro";

export async function generateBody(
  m: Measurements,
  heightCm: number,
  gender: "female" | "male" = "female",
  clothes: string[] = [],
  clothesScales: number[] = [],
  clothesStyles: string[][] = [],
  hair: HairStyle = "auto",
): Promise<string> {
  const res = await fetch(`${SERVICE_URL}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bust: m.bust,
      waist: m.waist,
      hip: m.hip,
      shoulder: m.shoulder ?? 0,
      height: heightCm,
      gender,
      clothes, // prendas reales (assets .mhclo) a vestir en Blender
      clothes_scales: clothesScales, // escala por talla, en paralelo a `clothes`
      clothes_styles: clothesStyles, // siluetas del catálogo de cada prenda, en paralelo a `clothes`
      hair, // peinado: auto | none | short | bob | long | ponytail | braids | afro
    }),
  });
  if (!res.ok) {
    throw new Error(`El servicio respondió ${res.status}`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

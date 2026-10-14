# Probador por tallas — arquitectura y guía

Sistema que responde a la pregunta de negocio: **"esta persona, con estas medidas,
¿cómo le queda la talla S / M / L de esta prenda?"** — y viste un maniquí 3D
realista con la prenda a la talla elegida.

---

## 1. Principio de diseño (léelo antes de tocar nada)

> **Una prenda no es su foto.** La **imagen** aporta la **textura** (color, estampado).
> La **tabla de tallas** aporta la **forma y el tamaño**. Son dos entradas distintas.

Por eso NO reconstruimos geometría 3D desde la foto (los modelos "image-to-3D" son
imprecisos por talla y no se pueden graduar). Seguimos la arquitectura de la industria
(CLO3D / Browzwear): **cuerpo paramétrico + prenda dimensionada por talla + motor de
holgura**.

Distinción importante: un *try-on 2D fotorrealista* (generación de imagen) es **otro
producto** — bonito, pero **no sabe de tallas ni de ajuste**. El objetivo de tallas
exige el camino 3D paramétrico.

---

## 2. Las 4 piezas

| Pieza | Dónde | Estado |
|---|---|---|
| **Cuerpo paramétrico** por medidas | `tools/gen_avatar.py` → GLB (Blender/MPFB2) | ✅ |
| **Prenda dimensionada por talla** | `apps/web/src/lib/garmentFit.ts` (`buildGarmentSized`) | ✅ |
| **Motor de holgura** (fit) | `packages/style-engine/src/sizing.ts` | ✅ |
| **Drape físico** (pliegues de tela) | — | Pendiente (Fase 4) |

Flujo completo:

```
Subir prenda (imagen → color + textura · tallas manual/CSV · tejido)
   → POST /catalog (persistido en SQLite)
   → seleccionar prenda en el probador
   → recommendSize(medidas, tallas, tejido) → talla recomendada
   → buildGarmentSized() viste el cuerpo GLB a esa talla (+ textura)
   → el usuario cambia de talla · activa el mapa de ajuste
```

---

## 3. Modelo de datos

`packages/style-engine/src/catalog.ts` y `sizing.ts`.

```ts
interface Garment {
  id: string;
  nombre: string;
  categoria: "top" | "bottom" | "dress" | "outerwear";
  genero: "female" | "male" | "unisex";
  color: string;          // hex #RRGGBB (color base / dominante)
  siluetas: string[];     // etiquetas para el recomendador
  precio: number;
  tallas?: SizeChart;     // ← medidas de la PRENDA por talla
  tejido?: Fabric;        // ← elasticidad
  texturaUrl?: string;    // ← imagen (URL o data URL) para el render 3D
}

// Medidas de la PRENDA TERMINADA (cm), no del cuerpo. Todas opcionales.
interface GarmentMeasures {
  chest?; waist?; hip?; thigh?; shoulder?; length?; sleeve?; inseam?;
}
type SizeLabel = "XXS"|"XS"|"S"|"M"|"L"|"XL"|"XXL"|"XXXL";
type SizeChart = Partial<Record<SizeLabel, GarmentMeasures>>;

interface Fabric {
  tipo: "punto" | "plano";  // punto = elástico; plano = rígido
  stretchPct: number;       // % de elasticidad utilizable (0 = rígido)
}
```

Las medidas son **circunferencias de la prenda terminada** (contorno de pecho de la
camiseta, no del cuerpo). `length`/`inseam`/`sleeve` son largos.

---

## 4. Motor de holgura (fit)

`packages/style-engine/src/sizing.ts` — lógica pura, testeada (`test/sizing.test.ts`).

### Estado por zona — `fitStateFor(bodyCm, garmentCm, stretchPct)`

```
maxBody = garmentCm * (1 + stretchPct/100)   // hasta aquí estira el tejido
si bodyCm > maxBody           → "no-entra"
easePct = (garmentCm - bodyCm) / bodyCm * 100
si easePct < -stretchPct*0.5  → "muy-ajustada"
si easePct < 3                → "ajustada"
si easePct < 12               → "regular"
si easePct < 28               → "holgada"
si no                         → "oversize"
```

La **holgura** (`ease`) = `prenda − cuerpo`. Negativa = la prenda aprieta; el tejido
de `punto` tolera algo de negativo (estira), el `plano` no.

### Ajuste de una talla — `computeFit(body, measures, fabric, size)`

Compara solo las zonas presentes en prenda **y** cuerpo:
`chest↔bust`, `shoulder↔shoulder`, `waist↔waist`, `hip↔hip`. Devuelve por zona la
holgura en cm/%, el estado, y un `score` global (0..1) donde **manda la peor zona**.

### Talla recomendada — `recommendSize(body, chart, fabric)`

Evalúa toda la tabla, descarta las que no entran, y elige la de mayor `score`
(holgura cercana a la ideal, ~8 %). Devuelve `{ best, all, nota }`.

```ts
recommendSize({ bust: 96, waist: 90, hip: 96 }, tee.tallas, tee.tejido)
// → { best: "M", nota: "Tu talla: M (regular)", all: [...] }
```

---

## 5. Formato CSV de tallas

`parseSizeChartCSV(csv)` en `sizing.ts`. Cabecera + una fila por talla. Columnas
desconocidas se ignoran; celdas vacías = medida ausente; errores se reportan sin abortar.

```csv
talla,chest,waist,hip,length,sleeve
S,96,84,98,70,20
M,102,90,104,72,21
L,108,96,110,74,22
```

Columnas válidas: `chest, waist, hip, thigh, shoulder, length, sleeve, inseam`.
`sizeChartToCSV(chart)` hace el inverso (exportar).

---

## 6. API — alta de prenda

`apps/api/src/app.ts`. La tabla `catalog` tiene columnas `tallas`, `tejido`,
`textura_url` (JSON de texto; migración idempotente `ensureColumn` en `db.ts`).

### `POST /catalog` (requiere sesión)

```jsonc
// body
{
  "nombre": "Camiseta cuello redondo",
  "categoria": "top",           // top|bottom|dress|outerwear
  "genero": "male",             // female|male|unisex
  "color": "#3A3A3E",           // #RRGGBB obligatorio
  "precio": 22,
  "siluetas": ["recto"],        // opcional
  "tallas": { "S": {"chest":96,"waist":92}, "M": {"chest":102,"waist":98} }, // opcional
  "tejido": { "tipo": "punto", "stretchPct": 8 },  // opcional
  "texturaUrl": "data:image/jpeg;base64,..."       // opcional
}
// → 201 { id: "top-xxxxxxxx", ...Garment }
```

Validaciones: nombre no vacío, categoría/género en su conjunto, color hex, precio ≥ 0.
`GET /catalog` y `GET /catalog/:id` devuelven `tallas`/`tejido`/`texturaUrl` si existen.
Cliente: `createGarment()` en `apps/web/src/lib/api.ts`.

---

## 7. Render 3D por talla

`apps/web/src/lib/garmentFit.ts` — `buildGarmentSized(...)`.

- **Dimensionado por números** (no por muestreo del ancho de la malla): el tamaño sale
  de las medidas de talla + medidas del cuerpo (`rxFromCirc`), NO de medir el ancho del
  GLB — así los brazos no contaminan el ancho (antes el brazo se colaba en la banda y
  salía un barril). El cuerpo solo aporta el centro y, en piernas, la trayectoria. La
  prenda nunca entra por dentro (holgura mínima → mata el z-fighting) y el top **cierra
  hacia el cuello** con un canesú (no un cubo abierto). Una **M y una L se ven distintas**.
- **Mapa de ajuste** (`showFit`): colorea la prenda por altura con `fitStateFor`
  (verde=regular, ámbar=ajustada, rojo=no-entra/muy-ajustada, azul=holgada/oversize),
  vía color por vértice.
- **Textura**: si hay `texturaUrl`, se aplica como material tileado (RepeatWrapping
  3×3) con UVs generadas en los lofts. Óptimo con *swatch*/patrón plano; una foto de
  producto completa tila raro (mejora pendiente: proyección UV frontal).
- Sin `tallas`/`tejido` → cae a `buildGarmentForBody` (ajuste al cuerpo, sin talla).

Solo actúa sobre el **cuerpo GLB real** (servicio Blender). Sin el servicio, el visor
usa el maniquí procedural (`avatar.ts`), que ignora tallas.

---

## 8. UI

- **`SizeChartImporter.tsx`** (panel derecho): pega/sube CSV → valida → previsualiza →
  muestra la talla recomendada en vivo con tus medidas.
- **`GarmentUploader.tsx`** (modal "+ prenda", cabecera, requiere sesión): datos
  básicos + **imagen** (auto-color dominante + textura) + **rejilla de tallas manual**
  por categoría o **relleno por CSV** + tejido + siluetas.
- **`Stage.tsx`** (visor 3D): selector de talla por prenda (arranca en la **recomendada**,
  marcada con punto verde), badge de estado de ajuste, y toggle **"Ajuste"** (heat map).

---

## 9. Probar de punta a punta

```bash
# 1. Backend (catálogo + cuentas)
cd apps/api && npm run dev            # :8787

# 2. Servicio de cuerpo GLB (necesario para el vestido por talla)
cd tools && docker compose up --build # :8123

# 3. Front
cd apps/web && npm run dev
```

1. Regístrate / inicia sesión → **"+ prenda"** → sube imagen, rellena tallas, guarda.
2. Sube tu retrato → *Estimar medidas* → **Avatar 3D**.
3. Selecciona la prenda → cambia de talla → activa **Ajuste**.

Prendas de ejemplo con tallas ya cargadas: **Camiseta cuello redondo** (`m-top-03`,
punto) y **Pantalón chino** (`m-bottom-01`, plano).

---

## 10. Tests

```bash
cd packages/style-engine && npx vitest run   # 37 tests (motor de fit + CSV)
cd apps/api && npm test                       # 15 tests (incluye POST /catalog)
```

---

## 11. Pendiente (Fase 4)

- **Proyección UV frontal** para fotos de producto no tileables.
- **Roles** comerciante/comprador (hoy cualquier usuario con sesión puede crear prenda).
- **Drape físico** de tela (pliegues reales) — el nivel caro; requiere solver de tela.

# Croma · generador de avatar 3D (Blender headless + MPFB2 + FastAPI)

Servicio que, a partir de medidas, devuelve un **GLB** con cuerpo, cabeza (pelo, cejas,
pestañas, ojos) y prendas ajustadas. Todo corre en Docker (CPU, sin GPU).

```bash
cd tools && docker compose up --build -d      # http://localhost:8123
curl localhost:8123/health
```

- **Reinicio**: `restart: unless-stopped` + healthcheck sobre `/health` (cada 30 s). Si el
  contenedor cae, Docker lo levanta. Un `up --build` lo recrea (corte de unos segundos).
- Blender es x86_64: en Apple Silicon se emula (`platform: linux/amd64`). Cada GLB tarda ~3–6 s;
  el servicio limita a 2 Blender en paralelo (`MAX_PARALLEL`) y reintenta una vez si falla.

## POST /generate  (devuelve el GLB)  ·  POST /generate-to-file  (lo deja en `apps/web/public/models`)

```jsonc
{
  "bust": 91, "waist": 73, "hip": 98,   // cm (circunferencias)
  "height": 170,                         // cm
  "gender": "female",                    // "female" | "male"
  "hair": "auto",                        // auto | none | short | bob | long | ponytail | braids | afro
  "clothes": ["camiseta", "pantalon"],   // carpetas de tools/assets/clothes (ver abajo)
  "clothes_scales": [1.0, 1.0],          // talla por prenda (1 = base; <1 ajusta, >1 holgado)
  "clothes_styles": [["cuello-polo"], ["slim"]]   // etiquetas de silueta por prenda
}
```

`clothes_scales` y `clothes_styles` van en paralelo a `clothes`. Etiquetas desconocidas se ignoran.
`hair: "auto"` = largo en mujer, corto en hombre. `afro` y `braids` se generan en Blender sobre la
cabeza (el resto son assets CC0 del pack de MakeHuman).

### Carpetas de prenda (`tools/assets/clothes/<carpeta>`)

| Carpeta | Tipo | Cubre | Notas |
|---|---|---|---|
| `camiseta` | top | torso | tags: `cuello-polo`, `cuello-redondo`, `camisa`, `punto`, `manga-abullonada`, `peplum`, `hombro-estructurado`, `tejido-fluido` |
| `pantalon` | bottom | piernas | tags: `pantalon-pierna-ancha`, `pantalon-recto`/`recto`, `slim` |
| `falda` | bottom | piernas | vestido recortado en la cintura; tag `falda-acampanada` |
| `vestido` | dress | torso + piernas | tags: `corte-a`, `vestido-cruzado`, `linea-imperio`, `tejido-fluido` |
| `chaqueta` | capa exterior | — | vaquera; tags: `capucha`, `peplum`, `hombro-estructurado` |
| `sudadera` | capa exterior | — | capucha, bolsillo canguro, cordones |
| `blazer` | capa exterior | — | solapas, abierto al frente |
| `cardigan` | capa exterior | — | botones; `punto`/`peplum` |

Si el pedido no cubre torso y/o piernas se viste esa zona con **ropa básica** (`basewear_*`).
Las capas exteriores nunca cuentan como cobertura: debajo siempre va una camiseta básica
(en mujer, alargada hasta la cadera). `sudadera`, `blazer`, `cardigan` y los tops `camisa`/`punto`/
`cuello-redondo` se derivan del pack de sistema (ver `SYSTEM_OUTER` en `gen_avatar.py`).

### Contrato de nombres de malla en el GLB (el visor depende de él)

`base` (cuerpo) · `clothes_<i>` (prendas en el orden del pedido) · `hair` · `eyebrows` · `eyelashes`
· `eyes` · `basewear_<i>`. Nombre de objeto y de malla iguales. El pelo procedural lleva color por
vértice (`COLOR_0`, variación de claridad) para que el visor lo multiplique por el color de pelo.
Texturas: sin mapas de normales, ≤1024 px (pelo/ojos ≤512, cejas/pestañas ≤256); GLB típico 1.3–2.4 MB.

## Ficheros

- `serve.py` — API (FastAPI): resuelve carpetas, cobertura y etiquetas; lanza Blender.
- `gen_avatar.py` — todo el pipeline en Blender (MPFB2): cuerpo, pose (brazos relajados y manos), pelo,
  basewear, prendas, máscaras de piel, optimización de texturas y export.
- `garment_shapes.py` — deformaciones de silueta por etiqueta y detalles (cuellos, bolsillo, botones...).
- `prep_assets.py` — se ejecuta en el build: rellena el color de los bordes transparentes de las texturas.
- `Dockerfile` — Blender 4.2 + MPFB v2.0.17 + assets CC0 de MakeHuman (créditos en `assets/clothes/CREDITS.md`).

## Revisar a ojo: `preview_glb.py`

```bash
blender -b -P tools/preview_glb.py -- --glb a.glb --out /tmp/p   # -> /tmp/p_front|34|side.png
```

Flags: `--focus <0..1>` (altura relativa del centro) y `--span <m>` (primer plano), `--fx <m>`
(desplazamiento lateral), `--back` (vistas de espalda `back` y `back34`), `--vcol` (renderiza también
el color por vértice `_vc`), `--poke` (cuerpo en rojo, resto gris: delata piel que asoma),
`--hide a,b` (oculta mallas por prefijo de nombre).

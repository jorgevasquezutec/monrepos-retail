# monrepos-retail

Plataforma de **probador virtual 3D + asesor de estilo por IA** para retail de moda.
Construida 100% con tecnología propia / open-source (sin APIs de pago).

## Estado: MVP-1 ✅

El primer incremento entregable: **asesor de estilo por colorimetría y morfología**.
El usuario sube una foto (procesada solo en local), introduce sus medidas y obtiene:

1. Su **estación de color** (sistema de las 12 estaciones) + paleta recomendada.
2. Su **figura corporal** (5 tipos) + objetivo estilístico.
3. Un **catálogo filtrado** por afinidad de color y silueta.

Todo sin 3D, sin subir datos y sin dependencias externas de pago.

## Estructura

```
packages/style-engine/   Motor de lógica pura (colorimetría, morfología, recomendador, tallas/ajuste). Testeado.
  src/sizing.ts            Tallaje: SizeChart, motor de holgura (computeFit/recommendSize), parser CSV.
apps/web/                Interfaz React + Vite + Three.js.
  src/lib/avatar.ts        Avatar paramétrico procedural (torso lofteado por medidas).
  src/lib/bodyEstimate.ts  Estimación de medidas + sexo desde foto (MediaPipe).
  src/lib/garmentFit.ts    Prendas que siguen el cuerpo real y se dimensionan por talla (buildGarmentSized).
  src/lib/api.ts           Cliente del backend (catálogo, alta de prenda).
  src/components/          Stage (viewport + selector de talla), AvatarViewport (Three.js),
                           SizeChartImporter (CSV), GarmentUploader (alta de prenda), panel.
apps/api/                Backend de aplicación (Fastify + SQLite integrado + JWT).
  src/db.ts, src/app.ts    Esquema/seed y todas las rutas (incl. POST /catalog).
tools/                   Generador de cuerpo CC0 (Blender + MPFB2, Docker).
docs/probador-tallas.md  Arquitectura y guía del probador por tallas.
```

## Backend (apps/api)

Fastify + `node:sqlite` (SQLite integrado en Node, sin dependencias nativas) + JWT.
39 pruebas en verde (26 motor + 13 API).

```bash
pnpm dev:api          # http://localhost:8787  (db: apps/api/data/croma.db)
pnpm --filter @retail/api test
```

Endpoints: `/auth/{register,login,me}`, `/catalog[?genero=&categoria=]`, `/profile`
(GET/PUT), `/favorites`, `/cart`, `/orders`, `/privacy/{policy,consent}`, `DELETE /me`
(derecho al olvido). **Privacidad por diseño:** la API nunca recibe fotos; el análisis
es en el navegador y solo se guardan resultados si el usuario lo autoriza.

## Requisitos

- Node ≥ 22, pnpm ≥ 10

## Uso

```bash
pnpm install        # instala todo el workspace
pnpm test           # corre los tests del motor (26 casos)
pnpm dev            # arranca la web en http://localhost:5173
pnpm build          # build de producción
```

## Roadmap (según el plan de investigación)

- [x] **MVP-1** · Colorimetría + morfología + recomendador
- [x] **MVP-2** · Visor 3D (Three.js): avatar paramétrico procedural que responde a
      las medidas, teñido con el tono de piel, con try-on de prendas y órbita 360°
- [x] **MVP-2.5** · Malla del avatar mejorada (hombros en pendiente, extremidades
      cónicas fundidas), prendas por categoría (vestido acampanado, top con tirantes,
      pantalón de 2 perneras, abrigo) y entorno PBR para iluminación
- [x] **MVP-4** · Cuerpo humano REAL desde la foto (fidelidad). ✅ FUNCIONA de punta
      a punta: foto → medidas → Blender/MPFB2 en Docker → GLB → visor. Cuerpo CC0
      (MakeHuman/MPFB2), sin SMPL, sin GPU. `docker compose up` + un `curl`.
- [x] **MVP-4.1** · Front conectado al servicio: al pulsar "Generar mi cuerpo" el
      front hace POST de las medidas → recibe el GLB → lo carga. Cada foto/medida
      genera su propio cuerpo (verificado: delgada vs grande). Requiere el servicio
      arriba (`docker compose up`) y CORS habilitado.
- [x] **MVP-4.2** · Calibración de tamaño: sexo correcto (bug arreglado), y para
      tallas grandes se añaden modificadores de barriga (stomach-pregnant/tone) y
      grosor de brazos/muslos/pantorrillas → figura manzana realista. Auto-regenera
      al cambiar medidas.
- [x] **MVP-4.3a** · Pose relajada: el generador baja los brazos (T-pose → A-pose)
      rotando `upperarm01.L/R` y fijando la pose como reposo.
- [x] **MVP-4.3b** · Prendas sobre el cuerpo REAL: `garmentFit.ts` dimensiona la
      prenda con las medidas y la coloca a las alturas anatómicas del GLB → el
      try-on de catálogo ya viste el cuerpo humano real (vestido/top/pantalón/abrigo).
- [x] **MVP-4.4** · Selector de sexo (mujer/hombre), presets de silueta (reloj de
      arena/pera/manzana/rectángulo/triángulo inv.), quitar prenda (toca de nuevo),
      y prendas que SIGUEN la superficie real del cuerpo (muestreo de malla). Try-on
      marcado "en desarrollo".
- [x] **MVP-4.5** · Robustez de medición: `bodyEstimate.ts` mide el ancho del torso
      con **escaneo contiguo desde el centro** (ignora brazos/codos separados) y
      **detecta la pose "manos en la cintura"** (avisa + recorta). `gen_avatar.py`
      suaviza la barriga (`stomach-pregnant` según sexo) para no inflar figuras
      delgadas. Prendas del maniquí: top sin barril + perneras que siguen la pierna.
- [x] **MVP-5** · Backend de aplicación: cuentas (JWT), catálogo en BD, perfil,
      favoritos, carrito, pedidos, privacidad/consentimiento, borrado de cuenta.
      Front conectado al catálogo del backend (con fallback local).
- [ ] **V2** · Simulación de tela con pliegues reales (prototipo en scratchpad);
      UI de cuenta/carrito/checkout en el front; pasarela de pago real; despliegue
      en la nube (front + API + servicio de avatar).
- [x] **MVP-2.6** · Ropa REAL como malla GLB (MPFB en Blender): las prendas del
      catálogo se ajustan al cuerpo y se deforman según sus etiquetas de silueta
      (`clothes_styles`: pierna ancha, slim, falda, corte A, imperio, manga abullonada,
      peplum, cuello polo/camisa/redondo, capucha, blazer, punto…). Capas: ropa base
      neutra donde no hay prenda, abrigos por encima (también sobre vestido).
- [x] **MVP-7** · Avatar realista: pelo (8 estilos, afro y trenzas procedurales),
      cejas, pestañas y ojos (assets CC0 de MakeHuman); pose relajada; piel y color
      de pelo automáticos desde la foto; materiales por malla; GLB ~2 MB.
- [x] **MVP-8** · Probador en vivo con cámara (2D, MediaPipe Pose en el navegador,
      sin subir vídeo) y suite e2e con Playwright (`pnpm test:e2e`).
- [x] **MVP-3** · Estimación de medidas desde la foto (MediaPipe Pose + máscara de
      silueta + altura como referencia de escala) → autollena busto/cintura/cadera/
      hombros y el avatar se genera desde la imagen. Precisión aproximada, ajustable.
- [ ] **V2** · Simulación de tela en vivo (WebGPU / PBD)
- [x] **MVP-6** · **Probador por tallas** (ver [docs/probador-tallas.md](docs/probador-tallas.md)):
  - [x] Motor de tallaje y ajuste (`sizing.ts`): `SizeChart`/`Fabric`, holgura por zona,
        `computeFit`/`recommendSize`, parser CSV. 37 tests.
  - [x] Vestido 3D **por talla** con mapa de calor de ajuste (`buildGarmentSized`);
        selector de talla en el visor que arranca en la recomendada.
  - [x] Alta de prenda con persistencia: `POST /catalog` + modal `GarmentUploader`
        (rejilla manual/CSV, tejido, siluetas). Columnas `tallas/tejido/textura_url`.
  - [x] Imagen de la prenda → color dominante automático + textura tileada en 3D.
  - [ ] Proyección UV frontal para fotos de producto; roles comerciante/comprador.

## Cuerpo real CC0 (MVP-4) — runbook del generador

El maniquí procedural es un marcador de posición. Para un cuerpo humano fiel con
licencia libre (sin SMPL, sin GPU):

1. Instala **Blender** (blender.org, gratis).
2. Instala el addon **MPFB2** (github.com/makehumancommunity/mpfb2) — assets CC0,
   uso comercial libre.
3. (Pendiente) Script `tools/gen_avatar.py`: Blender headless que recibe las
   medidas y exporta el cuerpo a GLB.
4. Coloca el GLB en `apps/web/public/models/avatar-body.glb` → el visor lo carga
   automáticamente (si no existe, usa el maniquí procedural).

El frontend ya consume `/models/avatar-body.glb` (ver `AvatarViewport.tsx`).

## Privacidad (Fase 5)

Las imágenes se procesan exclusivamente en el navegador vía `<canvas>` en memoria.
Ningún dato biométrico se transmite ni se almacena.

## Pruebas e2e

Suite end-to-end con Playwright (Chromium) en `e2e/`: API (`api.spec.ts`), flujo web
(`web.spec.ts`) y probador en vivo con cámara falsa (`camera.spec.ts`).

```bash
pnpm install
pnpm exec playwright install chromium   # solo la primera vez
pnpm test:e2e                           # levanta API (:8787) y web (:5173) si no están corriendo
pnpm exec playwright show-report e2e/.report
```

- `playwright.config.ts` arranca el API con una BD en memoria (nueva en cada ejecución) y la web con Vite. Si ya hay servidores en 8787/5173 los reutiliza
  (fuera de CI); en ese caso el API usa su BD real, por lo que cada test crea un usuario
  único (`e2e+<timestamp>@test.dev`) y lo borra con `DELETE /me`.
- La cámara se simula con `--use-fake-device-for-media-stream` y permiso `camera`.
- El test web comprueba el mensaje "No se pudo generar" solo si el servicio de cuerpo
  (`127.0.0.1:8123`) está caído.

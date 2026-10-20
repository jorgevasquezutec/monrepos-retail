# Importador de catálogo de fábrica

Convierte las planillas Excel de la fábrica (stock por talla + fotos embebidas)
en el catálogo que consume la web (`apps/web/public/shirley/`).

La fábrica registra **stock por talla** y **fotos**, pero NO fichas técnicas con
medidas de prenda. Por eso el ajuste en la app usa tablas estándar por tipo de
prenda (`packages/style-engine/src/defaultCharts.ts`); si algún día llega la
ficha real, esa manda.

## Uso

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# 1) estructura (modelo, descripción, colores, tallas con stock, tipo inferido)
python extract_catalog.py catalog.json

# 2) fotos embebidas, asociadas a cada modelo por su ancla de celda
python extract_photos.py photos   # -> photos/ + photos_map.json

# 3) fusiona la foto en el catálogo y copia a la web:
#    añade el campo "foto" a cada modelo y copia catalog.json + photos/
#    a apps/web/public/shirley/{catalogo.json,fotos/}

# 4) color dominante por prenda (desde la zona central de cada foto):
#    añade el campo "color" (hex) a cada modelo de apps/web/public/shirley/catalogo.json
pip install Pillow
python compute_colors.py apps/web/public/shirley
```

Fuente esperada en `/Users/jorge/Documents/shirley/`:
`Catálogo cliente con fotos.xlsx` (hoja `Catálogo`, columnas
FOTO|MODELO|DESCRIPCIÓN|COLOR|XS..OTRA|TOTAL|PESO).

> Las rutas de origen están al principio de cada script (constante `BASE`).

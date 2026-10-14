# Assets de ropa CC0 (para el Camino A · ropa real en Blender)

Para vestir el cuerpo con **geometría real** (no tubos), MPFB necesita prendas en
formato **MakeHuman** (`.mhclo` + su malla `.obj` + textura opcional). Aquí es
donde las colocas; el pipeline de Blender las carga y las **ajusta a la forma del
cuerpo** automáticamente.

## Estructura esperada

```
tools/assets/clothes/
  camiseta/
    camiseta.mhclo
    camiseta.obj
    camiseta.png        (opcional, textura)
  pantalon/
    pantalon.mhclo
    pantalon.obj
```

Cada carpeta = una prenda. El `.mhclo` referencia a su `.obj` (malla) y define
cómo se ajusta al cuerpo base de MakeHuman.

## De dónde sacar prendas CC0

- **MakeHuman Community Assets** — https://github.com/makehumancommunity/community-assets
  (carpeta `clothes/`). Revisa la licencia de cada prenda: usa solo **CC0 / CC-BY**.
- **MPFB System Assets** — MPFB puede descargar un pack de assets desde su UI
  (Blender con interfaz). Si lo haces en tu Blender local, copia los `.mhclo`
  resultantes aquí.
- **Propias** — cualquier malla de prenda modelada en Blender/MakeHuman y exportada
  a `.mhclo`.

## Cómo se cargan

El contenedor copia esta carpeta y `gen_avatar.py --clothes <ruta.mhclo>` la viste
sobre el cuerpo ya dimensionado. El mapeo *prenda del catálogo → asset .mhclo + talla*
lo define el backend (pendiente de cablear tras confirmar la API con `inspect_mpfb.py`).

## Estado

- [ ] Añadir al menos 1 prenda CC0 de prueba (p. ej. una camiseta) en `camiseta/`.
- [ ] Correr `inspect_mpfb.py` para fijar la API de carga de MPFB.
- [ ] Cablear `gen_avatar.py` para cargar y exportar la prenda ajustada.

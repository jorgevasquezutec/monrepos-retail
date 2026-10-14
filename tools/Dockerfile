# Croma · generador de cuerpo CC0 (Blender headless + MPFB2 + FastAPI)
# Todo dentro del contenedor: no tocas tu máquina. CPU, sin GPU.
FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive

# Versiones verificadas (jul 2026):
ARG BLENDER_VERSION=4.2.13
ARG BLENDER_SERIES=4.2
ARG MPFB_TAG=v2.0.17

# Librerías que Blender necesita aunque corra headless.
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget xz-utils ca-certificates unzip \
      libxrender1 libxi6 libxxf86vm1 libxfixes3 libxkbcommon0 \
      libgl1 libglu1-mesa libsm6 libice6 libegl1 libgles2 \
 && rm -rf /var/lib/apt/lists/*

# --- Blender (headless) ---
RUN wget -q "https://download.blender.org/release/Blender${BLENDER_SERIES}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" -O /tmp/blender.tar.xz \
 && mkdir -p /opt/blender \
 && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 \
 && rm /tmp/blender.tar.xz
ENV BLENDER_BIN=/opt/blender/blender

# --- Addon MPFB2 (desde el código fuente; assets CC0) ---
# En Blender 4.2 MPFB2 es una EXTENSIÓN (blender_manifest.toml). Los releases no
# adjuntan zip, así que empaquetamos src/mpfb como zip de extensión y lo
# instalamos con el CLI de Blender (queda habilitado y guardado en las prefs).
RUN wget -q "https://github.com/makehumancommunity/mpfb2/archive/refs/tags/${MPFB_TAG}.tar.gz" -O /tmp/mpfb.tar.gz \
 && mkdir -p /tmp/mpfb && tar -xzf /tmp/mpfb.tar.gz -C /tmp/mpfb --strip-components=1 \
 && python3 -c "import shutil; shutil.make_archive('/tmp/mpfb-ext','zip','/tmp/mpfb/src/mpfb')" \
 && /opt/blender/blender --background --command extension install-file -r user_default -e /tmp/mpfb-ext.zip \
 && rm -rf /tmp/mpfb /tmp/mpfb.tar.gz /tmp/mpfb-ext.zip

# --- Assets de sistema de MakeHuman (CC0 oficial): pelo, cejas, pestañas, ojos
# y ropa básica. El zip pesa ~280 MB; solo extraemos lo necesario y lo borramos.
ARG SYSTEM_ASSETS_URL=https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
ENV SYSTEM_ASSETS_DIR=/opt/croma-assets/system
COPY tools/prep_assets.py /tmp/prep_assets.py
RUN wget -q "${SYSTEM_ASSETS_URL}" -O /tmp/sys.zip \
 && mkdir -p ${SYSTEM_ASSETS_DIR} \
 && unzip -q /tmp/sys.zip -d ${SYSTEM_ASSETS_DIR} \
      'hair/short02/*' 'hair/bob02/*' 'hair/long01/*' 'hair/ponytail01/*' \
      'hair/braid01/*' 'hair/afro01/*' \
      'eyebrows/eyebrow001/*' 'eyelashes/eyelashes01/*' \
      'eyes/low-poly/*' 'eyes/materials/brown*' 'eyes/materials/blue*' \
      'clothes/female_sportsuit01/*' 'clothes/male_casualsuit02/*' 'clothes/male_elegantsuit01/*' \
 && find ${SYSTEM_ASSETS_DIR} -name '*.thumb' -delete \
 && pip install --no-cache-dir numpy pillow \
 && python /tmp/prep_assets.py ${SYSTEM_ASSETS_DIR} \
 && rm /tmp/sys.zip

# --- Servicio HTTP ---
WORKDIR /app
RUN pip install --no-cache-dir fastapi "uvicorn[standard]"
COPY tools/ /app/tools/

# Donde se escribe el GLB (se monta un volumen a apps/web/public/models).
ENV OUTPUT_DIR=/out
RUN mkdir -p /out

EXPOSE 8000
CMD ["uvicorn", "tools.serve:app", "--host", "0.0.0.0", "--port", "8000"]

#!/usr/bin/env bash
# Wrapper: tools/gen_avatar.sh <bust> <waist> <hip> <height> [gender]
# Requiere Blender en PATH (o define BLENDER_BIN).
set -euo pipefail

BLENDER_BIN="${BLENDER_BIN:-blender}"
BUST="${1:?bust cm requerido}"
WAIST="${2:?waist cm requerido}"
HIP="${3:?hip cm requerido}"
HEIGHT="${4:-168}"
GENDER="${5:-female}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/../apps/web/public/models/avatar-body.glb"

"$BLENDER_BIN" --background --python "$SCRIPT_DIR/gen_avatar.py" -- \
  --bust "$BUST" --waist "$WAIST" --hip "$HIP" --height "$HEIGHT" \
  --gender "$GENDER" --out "$OUT"

echo "Listo: $OUT"

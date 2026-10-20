import { useCallback, useEffect, useMemo, useState } from "react";
import {
  analyzeSeason,
  classifyBody,
  recommend,
  recommendSize,
  DEMO_CATALOG,
  type Garment,
  type RGB,
  type Measurements,
  type SizeLabel,
} from "@retail/style-engine";
import type { WornGarment } from "./components/AvatarViewport.tsx";
import { Stage, type Confidence } from "./components/Stage.tsx";
import { ProfilePanel } from "./components/ProfilePanel.tsx";
import { BodyForm, type Gender } from "./components/BodyForm.tsx";
import { Recommendations } from "./components/Recommendations.tsx";
import { SizeChartImporter } from "./components/SizeChartImporter.tsx";
import { GarmentUploader } from "./components/GarmentUploader.tsx";
import { CatalogoShirley } from "./components/CatalogoShirley.tsx";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { generateBody, type HairStyle } from "./lib/bodyService.ts";
import { assetForGarment, sizeScale } from "./lib/clothing.ts";
import { fetchCatalog, fetchMe, getToken, logout, type User } from "./lib/api.ts";

const SLOT_ORDER = ["top", "bottom", "dress", "outerwear"];

export function App() {
  // --- Sesión ---
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [guest, setGuest] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  useEffect(() => {
    if (!getToken()) {
      setAuthChecked(true);
      return;
    }
    fetchMe()
      .then(setAuthUser)
      .catch(() => logout())
      .finally(() => setAuthChecked(true));
  }, []);

  const [skin, setSkin] = useState<RGB | null>(null);
  const [hairColor, setHairColor] = useState<RGB | null>(null);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [hairStyle, setHairStyle] = useState<HairStyle>("auto");
  const [medidas, setMedidas] = useState<Measurements>({ bust: 92, waist: 70, hip: 96 });
  const [heightCm, setHeightCm] = useState(170);
  // ¿Medidas reales (formulario o foto) o las de por defecto? La cámara las estima si no.
  const [medidasKnown, setMedidasKnown] = useState(false);
  const setMedidasUser = useCallback((m: Measurements) => {
    setMedidasKnown(true);
    setMedidas(m);
  }, []);
  const [gender, setGender] = useState<Gender>("female");
  // Prendas puestas por zona (slot). El vestido ("dress") ocupa todo el cuerpo.
  const [selected, setSelected] = useState<Record<string, string>>({});

  // Catálogo: del backend si está disponible; si no, el local de respaldo.
  const [catalog, setCatalog] = useState<Garment[]>(DEMO_CATALOG);
  useEffect(() => {
    fetchCatalog().then(setCatalog).catch(() => {
      /* backend apagado → se usa DEMO_CATALOG */
    });
  }, []);

  // Alta de prenda (modal de gestión de catálogo).
  const [uploaderOpen, setUploaderOpen] = useState(false);

  // Catálogo real de la fábrica (Shirley): navegar y probar prendas reales.
  const [catalogoOpen, setCatalogoOpen] = useState(false);
  /** Lleva una prenda de la fábrica al avatar: la añade al catálogo y la viste. */
  const handleTryOnShirley = useCallback((g: Garment) => {
    setCatalog((prev) => (prev.some((x) => x.id === g.id) ? prev : [...prev, g]));
    const slot = g.categoria;
    setSelected((prev) => {
      const next = { ...prev };
      if (slot === "dress") {
        delete next.top;
        delete next.bottom;
        next.dress = g.id;
        return next;
      }
      if (slot === "top" || slot === "bottom") delete next.dress;
      next[slot] = g.id;
      return next;
    });
  }, []);

  // Cuerpo 3D real generado por el servicio (null → maniquí procedural).
  const [bodyUrl, setBodyUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Overrides de talla por prenda (el usuario cambia la talla en el visor).
  const [sizeOverrides, setSizeOverrides] = useState<Record<string, SizeLabel>>({});
  const handleSizeChange = useCallback((id: string, size: SizeLabel) => {
    setSizeOverrides((prev) => ({ ...prev, [id]: size }));
  }, []);

  // Prendas puestas: talla recomendada/efectiva + asset de ropa real (por
  // categoría si no tiene mhclo propio). El `mhclo` marca que va horneada en 3D.
  const selectedGarments = useMemo<WornGarment[]>(
    () =>
      // Orden de petición fijo: el abrigo siempre después del vestido/top/bottom.
      SLOT_ORDER.flatMap((slot) => (selected[slot] ? [selected[slot]!] : []))
        .map((id) => catalog.find((x) => x.id === id))
        .filter((g): g is NonNullable<typeof g> => !!g)
        .map((g) => {
          const avail = g.tallas ? (Object.keys(g.tallas) as SizeLabel[]) : [];
          const recommended = avail.length ? recommendSize(medidas, g.tallas!, g.tejido).best : null;
          const size = sizeOverrides[g.id] ?? recommended ?? avail[0];
          return {
            id: g.id,
            nombre: g.nombre,
            color: g.color,
            categoria: g.categoria,
            tallas: g.tallas,
            tejido: g.tejido,
            texturaUrl: g.texturaUrl,
            siluetas: g.siluetas,
            mhclo: assetForGarment(g), // asset real (propio o por categoría)
            size,
            recommended,
          };
        }),
    [selected, catalog, medidas, sizeOverrides],
  );

  // Prendas reales (con asset) → assets + escalas por talla, en el mismo orden.
  const realGarments = useMemo(
    () => selectedGarments.filter((g) => g.mhclo),
    [selectedGarments],
  );
  const clothesAssets = useMemo(() => realGarments.map((g) => g.mhclo!), [realGarments]);
  const clothesScales = useMemo(
    () => realGarments.map((g) => sizeScale(g.tallas, g.size, g.categoria)),
    [realGarments],
  );
  const clothesStyles = useMemo(() => realGarments.map((g) => g.siluetas ?? []), [realGarments]);
  // Firma que incluye la TALLA → cambiar de talla regenera el cuerpo en Blender.
  const clothesSig = useMemo(
    () => realGarments.map((g) => `${g.mhclo}:${g.size ?? ""}:${(g.siluetas ?? []).join("+")}`).join(","),
    [realGarments],
  );

  const handleGenerateBody = useCallback(async () => {
    if (!medidas.bust || !medidas.waist || !medidas.hip) return;
    setGenerating(true);
    setGenError(null);
    const attempt = () =>
      generateBody(medidas, heightCm, gender, clothesAssets, clothesScales, clothesStyles, hairStyle);
    try {
      let url: string;
      try {
        url = await attempt();
      } catch {
        // El servicio puede estar reiniciándose: un reintento automático a los ~3 s.
        await new Promise((r) => setTimeout(r, 3000));
        url = await attempt();
      }
      setBodyUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch {
      setGenError("No pudimos generar tu avatar.");
    } finally {
      setGenerating(false);
    }
  }, [medidas, heightCm, gender, clothesAssets, clothesScales, clothesStyles, hairStyle]);

  // Cada prenda ocupa la zona de su categoría. Un vestido quita top y bottom
  // (el abrigo convive con él); poner top/bottom quita el vestido.
  // Re-tocar la misma prenda de una zona la quita.
  const handleSelectGarment = useCallback(
    (id: string) => {
      const g = catalog.find((x) => x.id === id);
      if (!g) return;
      const slot = g.categoria;
      setSelected((prev) => {
        if (slot === "dress") {
          const next = { ...prev };
          delete next.top;
          delete next.bottom;
          if (next.dress === id) delete next.dress;
          else next.dress = id;
          return next;
        }
        const next = { ...prev };
        if (slot === "top" || slot === "bottom") delete next.dress;
        if (next[slot] === id) delete next[slot];
        else next[slot] = id;
        return next;
      });
    },
    [catalog],
  );

  // Tops del catálogo para la cámara: el polo primero.
  const quickPicks = useMemo(
    () =>
      catalog
        .filter((g) => g.categoria === "top")
        .sort((a, b) => Number(/polo/i.test(b.nombre)) - Number(/polo/i.test(a.nombre)))
        .slice(0, 5)
        .map((g) => ({ id: g.id, nombre: g.nombre, color: g.color })),
    [catalog],
  );

  const analysis = useMemo(() => (skin ? analyzeSeason(skin) : null), [skin]);
  const shape = useMemo(
    () => (medidas.bust && medidas.waist && medidas.hip ? classifyBody(medidas) : null),
    [medidas],
  );
  const recs = useMemo(
    () =>
      analysis && shape
        ? recommend({ season: analysis.season, shape, catalog, genero: gender })
        : [],
    [analysis, shape, gender, catalog],
  );

  const selectedIds = useMemo(() => new Set(Object.values(selected)), [selected]);

  const ready = analysis && shape && skin;

  const bodyControls = (
    <BodyForm
      value={medidas}
      onChange={setMedidasUser}
      gender={gender}
      onGenderChange={setGender}
      highlightMeasures={confidence === "baja"}
      hair={hairStyle}
      onHairChange={setHairStyle}
    />
  );

  // Gate de sesión: login/registro delante (o explorar sin cuenta).
  if (!authChecked) return <div className="app" />;
  if (!authUser && !guest) {
    return <AuthScreen onAuth={setAuthUser} onGuest={() => setGuest(true)} />;
  }

  const handleLogout = () => {
    logout();
    setAuthUser(null);
    setGuest(false);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">crom<b>a</b></span>
          <span className="kicker">studio</span>
        </div>
        <div className="status">
          <span className="dot" />
          {authUser ? (
            <>
              <button className="link-btn" onClick={() => setUploaderOpen(true)}>+ prenda</button>
              <span className="kicker">{authUser.name || authUser.email}</span>
              <button className="link-btn" onClick={handleLogout}>salir</button>
            </>
          ) : (
            <button className="link-btn" onClick={handleLogout}>entrar</button>
          )}
        </div>
      </header>

      <main className="main">
        <Stage
          onSkinColor={setSkin}
          onHairColor={setHairColor}
          onConfidence={setConfidence}
          confidence={confidence}
          hairColor={hairColor}
          hairStyle={hairStyle}
          onMeasurements={setMedidasUser}
          heightCm={heightCm}
          onHeightChange={setHeightCm}
          measurements={medidas}
          gender={gender}
          onGenderChange={setGender}
          skin={skin}
          garments={selectedGarments}
          quickPicks={quickPicks}
          onPickGarment={handleSelectGarment}
          measuresKnown={medidasKnown}
          onSizeChange={handleSizeChange}
          clothesSig={clothesSig}
          bodyUrl={bodyUrl}
          generating={generating}
          genError={genError}
          onGenerateBody={handleGenerateBody}
        />

        <aside className="panel">
          {ready ? (
            <>
              <ProfilePanel analysis={analysis} shape={shape} skin={skin} />
              {bodyControls}
              <Recommendations
                recs={recs}
                selectedIds={selectedIds}
                onSelect={handleSelectGarment}
              />
            </>
          ) : (
            <>
              <div className="empty-block">
                Sube un retrato en el escenario para leer tu color. Luego ajusta
                tus medidas y verás aquí tu estación, tu paleta y una selección
                del catálogo. Cámbiate al <strong>Avatar 3D</strong> para probártela.
              </div>
              {bodyControls}
            </>
          )}
          <button
            className="primary-btn catalogo-cta"
            onClick={() => setCatalogoOpen(true)}
          >
            Catálogo de fábrica · probar prendas reales
          </button>
          <SizeChartImporter measurements={medidas} />
        </aside>
      </main>

      {uploaderOpen && (
        <GarmentUploader
          onClose={() => setUploaderOpen(false)}
          onCreated={(g) => setCatalog((prev) => [...prev, g])}
        />
      )}

      {catalogoOpen && (
        <CatalogoShirley
          measurements={medidas}
          onClose={() => setCatalogoOpen(false)}
          onTryOn={handleTryOnShirley}
        />
      )}
    </div>
  );
}

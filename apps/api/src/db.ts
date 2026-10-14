/**
 * Base de datos (SQLite integrado en Node — sin dependencias nativas).
 * Crea el esquema y siembra el catálogo desde @retail/style-engine.
 */
import { DatabaseSync } from "node:sqlite";
import { DEMO_CATALOG, type Garment } from "@retail/style-engine";

export type DB = DatabaseSync;

export function createDb(path = ":memory:"): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  seedCatalog(db);
  return db;
}

/** Añade una columna si aún no existe (migración idempotente para BD de fichero). */
function ensureColumn(db: DB, table: string, col: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      gender TEXT, height_cm INTEGER,
      bust INTEGER, waist INTEGER, hip INTEGER, shoulder INTEGER,
      season_id TEXT, skin_hex TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog (
      id TEXT PRIMARY KEY, nombre TEXT NOT NULL, categoria TEXT NOT NULL,
      genero TEXT NOT NULL, color TEXT NOT NULL, precio REAL NOT NULL,
      siluetas TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      garment_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, garment_id)
    );
    CREATE TABLE IF NOT EXISTS cart_items (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      garment_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, garment_id)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      total REAL NOT NULL, items TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consents (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, granted INTEGER NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
  `);
  // Tallaje (Fase 3): columnas opcionales de tabla de tallas, tejido y textura.
  ensureColumn(db, "catalog", "tallas", "TEXT");
  ensureColumn(db, "catalog", "tejido", "TEXT");
  ensureColumn(db, "catalog", "textura_url", "TEXT");
  ensureColumn(db, "catalog", "mhclo", "TEXT");
}

function seedCatalog(db: DB): void {
  const row = db.prepare("SELECT COUNT(*) AS c FROM catalog").get() as { c: number };
  if (row.c === 0) {
    const ins = db.prepare(
      "INSERT INTO catalog (id,nombre,categoria,genero,color,precio,siluetas,tallas,tejido,textura_url,mhclo) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const g of DEMO_CATALOG) {
      ins.run(
        g.id, g.nombre, g.categoria, g.genero, g.color, g.precio, JSON.stringify(g.siluetas),
        g.tallas ? JSON.stringify(g.tallas) : null,
        g.tejido ? JSON.stringify(g.tejido) : null,
        g.texturaUrl ?? null,
        g.mhclo ?? null,
      );
    }
    return;
  }
  // Catálogo ya sembrado: rellena (backfill) los campos nuevos de las prendas
  // demo (siluetas/tallas/tejido/textura/mhclo) para BDs creadas antes de añadirlos.
  // Idempotente: se puede ejecutar en cada arranque sin borrar datos.
  const upd = db.prepare(
    "UPDATE catalog SET siluetas=?, tallas=?, tejido=?, textura_url=?, mhclo=? WHERE id=?",
  );
  for (const g of DEMO_CATALOG) {
    upd.run(
      JSON.stringify(g.siluetas),
      g.tallas ? JSON.stringify(g.tallas) : null,
      g.tejido ? JSON.stringify(g.tejido) : null,
      g.texturaUrl ?? null,
      g.mhclo ?? null,
      g.id,
    );
  }
}

/** Fila de catálogo -> objeto Garment (incluye tallas/tejido/textura si hay). */
export function rowToGarment(r: Record<string, unknown>): Garment {
  const g: Garment = {
    id: r.id as string,
    nombre: r.nombre as string,
    categoria: r.categoria as Garment["categoria"],
    genero: r.genero as Garment["genero"],
    color: r.color as string,
    precio: r.precio as number,
    siluetas: JSON.parse(r.siluetas as string),
  };
  if (r.tallas) g.tallas = JSON.parse(r.tallas as string);
  if (r.tejido) g.tejido = JSON.parse(r.tejido as string);
  if (r.textura_url) g.texturaUrl = r.textura_url as string;
  if (r.mhclo) g.mhclo = r.mhclo as string;
  return g;
}

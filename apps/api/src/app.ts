/**
 * API de la aplicación (Fastify). Cuentas (JWT), catálogo, perfil, favoritos,
 * carrito, pedidos y privacidad.
 *
 * Privacidad por diseño: la API NUNCA recibe fotos. El análisis de color y las
 * medidas se calculan en el navegador; aquí solo se guardan resultados
 * (medidas, estación, tono) si el usuario lo autoriza.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { createDb, rowToGarment, type DB } from "./db.ts";

interface BuildOpts {
  db?: DB;
  dbPath?: string;
  jwtSecret?: string;
}

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const nowIso = () => new Date().toISOString();
const uid = (req: FastifyRequest): number => (req.user as { sub: number }).sub;
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isNumOrNull = (v: unknown) => v == null || (typeof v === "number" && Number.isFinite(v));

export async function buildApp(opts: BuildOpts = {}): Promise<FastifyInstance> {
  const db = opts.db ?? createDb(opts.dbPath ?? ":memory:");
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: opts.jwtSecret ?? process.env.JWT_SECRET ?? "dev-secret-change-me", sign: { expiresIn: "7d" } });

  // Errores de Fastify (JSON mal formado, cuerpo demasiado grande...) con la misma forma { error }.
  app.setErrorHandler((err: { statusCode?: number; message: string }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) {
      console.error(err);
      return reply.code(500).send({ error: "Error interno" });
    }
    return reply.code(status).send({ error: status === 400 ? "Petición inválida" : err.message });
  });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
      // Un token firmado sigue siendo válido tras borrar la cuenta: comprobar que el usuario existe.
      if (!db.prepare("SELECT id FROM users WHERE id=?").get(uid(req))) throw new Error("usuario inexistente");
    } catch {
      return reply.code(401).send({ error: "No autorizado" });
    }
  };

  app.get("/health", async () => ({ ok: true }));

  // ---------------- Auth ----------------
  app.post("/auth/register", async (req, reply) => {
    const { email, password, name } = (req.body ?? {}) as Record<string, string>;
    if (typeof email !== "string" || !emailRe.test(email)) return reply.code(400).send({ error: "Email inválido" });
    if (typeof password !== "string" || password.length < 6) return reply.code(400).send({ error: "La contraseña necesita 6+ caracteres" });
    if (name != null && typeof name !== "string") return reply.code(400).send({ error: "Nombre inválido" });
    const mail = email.toLowerCase();
    if (db.prepare("SELECT id FROM users WHERE email=?").get(mail)) {
      return reply.code(409).send({ error: "Ese email ya está registrado" });
    }
    const hash = bcrypt.hashSync(password, 10);
    const res = db.prepare("INSERT INTO users (email,name,password_hash,created_at) VALUES (?,?,?,?)").run(mail, name ?? "", hash, nowIso());
    const id = Number(res.lastInsertRowid);
    db.prepare("INSERT INTO profiles (user_id, updated_at) VALUES (?,?)").run(id, nowIso());
    const token = app.jwt.sign({ sub: id, email: mail });
    return reply.code(201).send({ token, user: { id, email: mail, name: name ?? "" } });
  });

  app.post("/auth/login", async (req, reply) => {
    const { email, password } = (req.body ?? {}) as Record<string, string>;
    if (typeof email !== "string" || typeof password !== "string") {
      return reply.code(400).send({ error: "Email y contraseña son obligatorios" });
    }
    const u = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase()) as
      | Record<string, unknown>
      | undefined;
    if (!u || !bcrypt.compareSync(password, u.password_hash as string)) {
      return reply.code(401).send({ error: "Credenciales incorrectas" });
    }
    const token = app.jwt.sign({ sub: u.id as number, email: u.email as string });
    return { token, user: { id: u.id, email: u.email, name: u.name } };
  });

  app.get("/auth/me", { preHandler: authenticate }, async (req) => {
    const u = db.prepare("SELECT id,email,name,created_at FROM users WHERE id=?").get(uid(req));
    const profile = db.prepare("SELECT * FROM profiles WHERE user_id=?").get(uid(req));
    return { user: u, profile };
  });

  // ---------------- Catálogo ----------------
  app.get("/catalog", async (req) => {
    const { genero, categoria } = (req.query ?? {}) as Record<string, string>;
    const rows = db.prepare("SELECT * FROM catalog").all() as Record<string, unknown>[];
    return rows
      .filter((r) => (!genero || r.genero === genero || r.genero === "unisex") && (!categoria || r.categoria === categoria))
      .map(rowToGarment);
  });

  app.get("/catalog/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare("SELECT * FROM catalog WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!r) return reply.code(404).send({ error: "Prenda no encontrada" });
    return rowToGarment(r);
  });

  // Alta de prenda (gestión de catálogo). Requiere sesión. La tabla de tallas y
  // el tejido son opcionales; se guardan como JSON para el probador por tallas.
  const CATEGORIAS = new Set(["top", "bottom", "dress", "outerwear"]);
  const GENEROS = new Set(["female", "male", "unisex"]);
  app.post("/catalog", { preHandler: authenticate }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const nombre = typeof b.nombre === "string" ? b.nombre.trim() : "";
    const categoria = String(b.categoria ?? "");
    const genero = String(b.genero ?? "");
    const color = typeof b.color === "string" ? b.color.trim() : "";
    const precio = Number(b.precio);

    if (!nombre) return reply.code(400).send({ error: "Falta el nombre." });
    if (!CATEGORIAS.has(categoria)) return reply.code(400).send({ error: "Categoría inválida." });
    if (!GENEROS.has(genero)) return reply.code(400).send({ error: "Género inválido." });
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return reply.code(400).send({ error: "Color hex inválido (#RRGGBB)." });
    if (!Number.isFinite(precio) || precio < 0) return reply.code(400).send({ error: "Precio inválido." });

    const siluetas = Array.isArray(b.siluetas) ? b.siluetas.filter((s): s is string => typeof s === "string") : [];
    const tallas = b.tallas && typeof b.tallas === "object" ? JSON.stringify(b.tallas) : null;
    const tejido = b.tejido && typeof b.tejido === "object" ? JSON.stringify(b.tejido) : null;
    const texturaUrl = typeof b.texturaUrl === "string" && b.texturaUrl ? b.texturaUrl : null;

    const id = `${categoria}-${randomUUID().slice(0, 8)}`;
    db.prepare(
      "INSERT INTO catalog (id,nombre,categoria,genero,color,precio,siluetas,tallas,tejido,textura_url) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(id, nombre, categoria, genero, color, precio, JSON.stringify(siluetas), tallas, tejido, texturaUrl);

    const r = db.prepare("SELECT * FROM catalog WHERE id=?").get(id) as Record<string, unknown>;
    return reply.code(201).send(rowToGarment(r));
  });

  // ---------------- Perfil ----------------
  app.get("/profile", { preHandler: authenticate }, async (req) => {
    return db.prepare("SELECT * FROM profiles WHERE user_id=?").get(uid(req));
  });

  app.put("/profile", { preHandler: authenticate }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const k of ["height_cm", "bust", "waist", "hip", "shoulder"]) {
      if (!isNumOrNull(b[k])) return reply.code(400).send({ error: `${k} debe ser un número o null` });
    }
    for (const k of ["gender", "season_id", "skin_hex"]) {
      if (b[k] != null && typeof b[k] !== "string") return reply.code(400).send({ error: `${k} debe ser texto o null` });
    }
    db.prepare(
      `UPDATE profiles SET gender=?, height_cm=?, bust=?, waist=?, hip=?, shoulder=?, season_id=?, skin_hex=?, updated_at=?
       WHERE user_id=?`,
    ).run(
      (b.gender as string) ?? null,
      (b.height_cm as number) ?? null,
      (b.bust as number) ?? null,
      (b.waist as number) ?? null,
      (b.hip as number) ?? null,
      (b.shoulder as number) ?? null,
      (b.season_id as string) ?? null,
      (b.skin_hex as string) ?? null,
      nowIso(),
      uid(req),
    );
    return db.prepare("SELECT * FROM profiles WHERE user_id=?").get(uid(req));
  });

  // ---------------- Favoritos ----------------
  app.get("/favorites", { preHandler: authenticate }, async (req) => {
    const rows = db
      .prepare("SELECT c.* FROM favorites f JOIN catalog c ON c.id=f.garment_id WHERE f.user_id=?")
      .all(uid(req)) as Record<string, unknown>[];
    return rows.map(rowToGarment);
  });

  app.post("/favorites", { preHandler: authenticate }, async (req, reply) => {
    const { garmentId } = (req.body ?? {}) as { garmentId: unknown };
    if (!isStr(garmentId)) return reply.code(400).send({ error: "garmentId es obligatorio" });
    if (!db.prepare("SELECT id FROM catalog WHERE id=?").get(garmentId)) return reply.code(404).send({ error: "Prenda no encontrada" });
    db.prepare("INSERT OR IGNORE INTO favorites (user_id,garment_id,created_at) VALUES (?,?,?)").run(uid(req), garmentId, nowIso());
    return reply.code(201).send({ ok: true });
  });

  app.delete("/favorites/:garmentId", { preHandler: authenticate }, async (req) => {
    const { garmentId } = req.params as { garmentId: string };
    db.prepare("DELETE FROM favorites WHERE user_id=? AND garment_id=?").run(uid(req), garmentId);
    return { ok: true };
  });

  // ---------------- Carrito ----------------
  const cartItems = (userId: number) =>
    db
      .prepare("SELECT c.*, ci.qty AS qty FROM cart_items ci JOIN catalog c ON c.id=ci.garment_id WHERE ci.user_id=?")
      .all(userId) as Record<string, unknown>[];

  app.get("/cart", { preHandler: authenticate }, async (req) => {
    const rows = cartItems(uid(req));
    const items = rows.map((r) => ({ ...rowToGarment(r), qty: r.qty as number }));
    const total = items.reduce((s, i) => s + i.precio * i.qty, 0);
    return { items, total: Math.round(total * 100) / 100 };
  });

  app.post("/cart", { preHandler: authenticate }, async (req, reply) => {
    const { garmentId, qty } = (req.body ?? {}) as { garmentId: unknown; qty?: unknown };
    if (!isStr(garmentId)) return reply.code(400).send({ error: "garmentId es obligatorio" });
    if (qty != null && (!Number.isInteger(qty) || (qty as number) < 1 || (qty as number) > 99)) {
      return reply.code(400).send({ error: "qty debe ser un entero entre 1 y 99" });
    }
    if (!db.prepare("SELECT id FROM catalog WHERE id=?").get(garmentId)) return reply.code(404).send({ error: "Prenda no encontrada" });
    const q = (qty as number | undefined) ?? 1;
    db.prepare(
      `INSERT INTO cart_items (user_id,garment_id,qty) VALUES (?,?,?)
       ON CONFLICT(user_id,garment_id) DO UPDATE SET qty=MIN(qty+excluded.qty, 99)`,
    ).run(uid(req), garmentId, q);
    return reply.code(201).send({ ok: true });
  });

  app.delete("/cart/:garmentId", { preHandler: authenticate }, async (req) => {
    const { garmentId } = req.params as { garmentId: string };
    db.prepare("DELETE FROM cart_items WHERE user_id=? AND garment_id=?").run(uid(req), garmentId);
    return { ok: true };
  });

  // ---------------- Pedidos ----------------
  app.post("/orders", { preHandler: authenticate }, async (req, reply) => {
    const rows = cartItems(uid(req));
    if (rows.length === 0) return reply.code(400).send({ error: "El carrito está vacío" });
    const items = rows.map((r) => ({ ...rowToGarment(r), qty: r.qty as number }));
    const total = Math.round(items.reduce((s, i) => s + i.precio * i.qty, 0) * 100) / 100;
    const res = db
      .prepare("INSERT INTO orders (user_id,total,items,created_at) VALUES (?,?,?,?)")
      .run(uid(req), total, JSON.stringify(items), nowIso());
    db.prepare("DELETE FROM cart_items WHERE user_id=?").run(uid(req));
    return reply.code(201).send({ id: Number(res.lastInsertRowid), total, items });
  });

  app.get("/orders", { preHandler: authenticate }, async (req) => {
    const rows = db.prepare("SELECT id,total,items,created_at FROM orders WHERE user_id=? ORDER BY id DESC").all(uid(req)) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({ id: r.id, total: r.total, created_at: r.created_at, items: JSON.parse(r.items as string) }));
  });

  // ---------------- Privacidad (Fase 5) ----------------
  app.get("/privacy/policy", async () => ({
    resumen: "Tus fotos se procesan solo en tu navegador y nunca se envían ni se guardan.",
    puntos: [
      "El análisis de color y las medidas se calculan en tu dispositivo.",
      "La API solo guarda resultados (medidas, estación, tono) si tú lo autorizas.",
      "Puedes revocar el consentimiento y borrar tus datos cuando quieras.",
      "Cumplimos minimización de datos y consentimiento explícito (estilo GDPR).",
    ],
  }));

  app.post("/privacy/consent", { preHandler: authenticate }, async (req, reply) => {
    const { kind, granted } = (req.body ?? {}) as { kind?: unknown; granted?: unknown };
    if (kind != null && !isStr(kind)) return reply.code(400).send({ error: "kind debe ser texto" });
    if (typeof granted !== "boolean") return reply.code(400).send({ error: "granted debe ser booleano" });
    db.prepare(
      `INSERT INTO consents (user_id,kind,granted,at) VALUES (?,?,?,?)
       ON CONFLICT(user_id,kind) DO UPDATE SET granted=excluded.granted, at=excluded.at`,
    ).run(uid(req), kind ?? "general", granted ? 1 : 0, nowIso());
    return { ok: true };
  });

  // Borrado de cuenta y datos (derecho al olvido)
  app.delete("/me", { preHandler: authenticate }, async (req) => {
    db.prepare("DELETE FROM users WHERE id=?").run(uid(req)); // cascada borra el resto
    return { ok: true };
  });

  return app;
}

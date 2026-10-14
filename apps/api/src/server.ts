/** Arranque del servidor. DB persistente en disco (data/croma.db). */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildApp } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8787);
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.error("[api] JWT_SECRET es obligatorio en producción");
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH ?? "data/croma.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const app = await buildApp({ dbPath: DB_PATH });
await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[api] Croma API en http://localhost:${PORT}  (db: ${DB_PATH})`);

import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";

let app: FastifyInstance;
let token: string;

before(async () => {
  app = await buildApp({ dbPath: ":memory:", jwtSecret: "test" });
});

async function json(method: string, url: string, body?: unknown, auth = false) {
  const res = await app.inject({
    method: method as "GET",
    url,
    payload: body as object,
    headers: auth ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.json() as any };
}

test("health responde", async () => {
  assert.deepEqual((await json("GET", "/health")).body, { ok: true });
});

test("registra usuario y devuelve token", async () => {
  const r = await json("POST", "/auth/register", { email: "ana@test.com", password: "secret123", name: "Ana" });
  assert.equal(r.status, 201);
  assert.ok(r.body.token);
  token = r.body.token;
});

test("rechaza email duplicado", async () => {
  const r = await json("POST", "/auth/register", { email: "ana@test.com", password: "secret123" });
  assert.equal(r.status, 409);
});

test("rechaza contraseña corta", async () => {
  const r = await json("POST", "/auth/register", { email: "x@test.com", password: "123" });
  assert.equal(r.status, 400);
});

test("login correcto e incorrecto", async () => {
  assert.equal((await json("POST", "/auth/login", { email: "ana@test.com", password: "secret123" })).status, 200);
  assert.equal((await json("POST", "/auth/login", { email: "ana@test.com", password: "mala" })).status, 401);
});

test("/auth/me requiere token", async () => {
  assert.equal((await json("GET", "/auth/me")).status, 401);
  const r = await json("GET", "/auth/me", undefined, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, "ana@test.com");
});

test("catálogo lista y filtra por género", async () => {
  const all = await json("GET", "/catalog");
  assert.ok(all.body.length > 10);
  const men = await json("GET", "/catalog?genero=male");
  assert.ok(men.body.every((g: any) => g.genero === "male" || g.genero === "unisex"));
  const women = await json("GET", "/catalog?genero=female");
  assert.ok(women.body.some((g: any) => g.genero === "female"));
  assert.ok(!women.body.some((g: any) => g.genero === "male"));
});

test("crear prenda: requiere sesión y valida", async () => {
  // Sin token → 401.
  assert.equal((await json("POST", "/catalog", { nombre: "X", categoria: "top", genero: "unisex", color: "#112233", precio: 10 })).status, 401);
  // Categoría inválida → 400.
  assert.equal((await json("POST", "/catalog", { nombre: "X", categoria: "zzz", genero: "unisex", color: "#112233", precio: 10 }, true)).status, 400);
  // Color hex inválido → 400.
  assert.equal((await json("POST", "/catalog", { nombre: "X", categoria: "top", genero: "unisex", color: "rojo", precio: 10 }, true)).status, 400);
});

test("crear prenda con tallas: persiste y round-trip por GET", async () => {
  const tallas = { S: { chest: 96, waist: 84 }, M: { chest: 102, waist: 90 } };
  const tejido = { tipo: "punto", stretchPct: 8 };
  const r = await json(
    "POST",
    "/catalog",
    { nombre: "Camiseta test", categoria: "top", genero: "male", color: "#3A3A3E", precio: 22, tallas, tejido },
    true,
  );
  assert.equal(r.status, 201);
  assert.ok(r.body.id.startsWith("top-"));
  assert.deepEqual(r.body.tallas, tallas);
  assert.deepEqual(r.body.tejido, tejido);

  const got = await json("GET", `/catalog/${r.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.tallas, tallas);
  assert.equal(got.body.tejido.tipo, "punto");
});

test("guarda y recupera el perfil", async () => {
  const upd = await json("PUT", "/profile", { gender: "female", height_cm: 168, bust: 92, waist: 70, hip: 96, season_id: "true-autumn" }, true);
  assert.equal(upd.body.height_cm, 168);
  const got = await json("GET", "/profile", undefined, true);
  assert.equal(got.body.season_id, "true-autumn");
});

test("favoritos: añadir, listar, quitar", async () => {
  const g = (await json("GET", "/catalog")).body[0].id;
  assert.equal((await json("POST", "/favorites", { garmentId: g }, true)).status, 201);
  assert.equal((await json("GET", "/favorites", undefined, true)).body.length, 1);
  await json("DELETE", `/favorites/${g}`, undefined, true);
  assert.equal((await json("GET", "/favorites", undefined, true)).body.length, 0);
});

test("carrito y pedido completo", async () => {
  const cat = (await json("GET", "/catalog")).body;
  await json("POST", "/cart", { garmentId: cat[0].id, qty: 2 }, true);
  await json("POST", "/cart", { garmentId: cat[1].id }, true);
  const cart = await json("GET", "/cart", undefined, true);
  assert.equal(cart.body.items.length, 2);
  assert.ok(cart.body.total > 0);

  const order = await json("POST", "/orders", undefined, true);
  assert.equal(order.status, 201);
  assert.equal(order.body.total, cart.body.total);
  assert.equal((await json("GET", "/cart", undefined, true)).body.items.length, 0);
  assert.equal((await json("GET", "/orders", undefined, true)).body.length, 1);
});

test("pedido con carrito vacío falla", async () => {
  assert.equal((await json("POST", "/orders", undefined, true)).status, 400);
});

test("privacidad: política pública y consentimiento", async () => {
  assert.ok((await json("GET", "/privacy/policy")).body.puntos.length > 0);
  assert.equal((await json("POST", "/privacy/consent", { kind: "medidas", granted: true }, true)).body.ok, true);
});

test("borrado de cuenta (derecho al olvido)", async () => {
  const r = await json("POST", "/auth/register", { email: "borrar@test.com", password: "secret123" });
  const t2 = r.body.token;
  const del = await app.inject({ method: "DELETE", url: "/me", headers: { authorization: `Bearer ${t2}` } });
  assert.equal(del.statusCode, 200);
  assert.equal((await json("POST", "/auth/login", { email: "borrar@test.com", password: "secret123" })).status, 401);
});

test("validación: carrito rechaza cuerpos inválidos con 400", async () => {
  for (const body of [{}, { garmentId: 123 }, { garmentId: "" }, { garmentId: "x", qty: -3 }, { garmentId: "x", qty: 1.5 }, { garmentId: "x", qty: "2" }]) {
    const r = await json("POST", "/cart", body, true);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.body.error, "string");
  }
  assert.equal((await json("POST", "/cart", { garmentId: "no-existe" }, true)).status, 404);
});

test("validación: favoritos, perfil, consentimiento, auth y JSON roto", async () => {
  assert.equal((await json("POST", "/favorites", {}, true)).status, 400);
  assert.equal((await json("PUT", "/profile", { height_cm: "alto" }, true)).status, 400);
  assert.equal((await json("PUT", "/profile", { height_cm: null, gender: 5 }, true)).status, 400);
  assert.equal((await json("PUT", "/profile", { height_cm: null }, true)).status, 200);
  assert.equal((await json("POST", "/privacy/consent", { kind: "medidas", granted: "si" }, true)).status, 400);
  assert.equal((await json("POST", "/auth/login", {})).status, 400);
  assert.equal((await json("POST", "/auth/login", { email: 1, password: { length: 9 } })).status, 400);
  assert.equal((await json("POST", "/auth/register", { email: "q@test.com", password: { length: 9 } })).status, 400);
  const bad = await app.inject({ method: "POST", url: "/auth/login", payload: "{no json", headers: { "content-type": "application/json" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(typeof bad.json().error, "string");
});

test("un token de cuenta borrada deja de funcionar (401)", async () => {
  const r = await json("POST", "/auth/register", { email: "fantasma@test.com", password: "secret123" });
  const headers = { authorization: `Bearer ${r.body.token}` };
  assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: "/me", headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers })).statusCode, 401);
  const cart = await app.inject({ method: "POST", url: "/cart", headers, payload: { garmentId: "x" } });
  assert.equal(cart.statusCode, 401);
  assert.equal(cart.json().error, "No autorizado");
});

test("qty: máximo 99 y la suma del carrito se limita a 99", async () => {
  const g = (await json("GET", "/catalog")).body[2].id;
  assert.equal((await json("POST", "/cart", { garmentId: g, qty: 100 }, true)).status, 400);
  assert.equal((await json("POST", "/cart", { garmentId: g, qty: 1e20 }, true)).status, 400);
  assert.equal((await json("POST", "/cart", { garmentId: g, qty: 60 }, true)).status, 201);
  assert.equal((await json("POST", "/cart", { garmentId: g, qty: 60 }, true)).status, 201);
  const item = (await json("GET", "/cart", undefined, true)).body.items.find((i: any) => i.id === g);
  assert.equal(item.qty, 99);
  await json("DELETE", `/cart/${g}`, undefined, true);
});

test("el token incluye caducidad (exp ~7 días)", async () => {
  const r = await json("POST", "/auth/login", { email: "ana@test.com", password: "secret123" });
  const p = app.jwt.decode(r.body.token) as { iat: number; exp: number };
  assert.equal(p.exp - p.iat, 7 * 24 * 3600);
});

import { test, expect } from "@playwright/test";
import { API, PASSWORD, uniqueEmail } from "./helpers";

test("API: flujo completo de cuenta, carrito y pedido", async ({ request }) => {
  const email = uniqueEmail();

  const reg = await request.post(`${API}/auth/register`, { data: { email, password: PASSWORD, name: "E2E" } });
  expect(reg.status()).toBe(201);
  const { token } = await reg.json();
  const auth = { Authorization: `Bearer ${token}` };
  let deleted = false;
  try {

    const me = await request.get(`${API}/auth/me`, { headers: auth });
    expect(me.ok()).toBeTruthy();
    expect((await me.json()).user.email).toBe(email);

    const catalog = await (await request.get(`${API}/catalog`)).json();
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
    const garment = catalog[0];

    const add = await request.post(`${API}/cart`, { headers: auth, data: { garmentId: garment.id, qty: 2 } });
    expect(add.status()).toBe(201);
    const cart = await (await request.get(`${API}/cart`, { headers: auth })).json();
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].qty).toBe(2);
    expect(cart.total).toBeCloseTo(2 * garment.precio, 2);

    const order = await request.post(`${API}/orders`, { headers: auth });
    expect(order.status()).toBe(201);
    const created = await order.json();
    expect(created.total).toBeCloseTo(2 * garment.precio, 2);
    const orders = await (await request.get(`${API}/orders`, { headers: auth })).json();
    expect(orders.map((o: { id: number }) => o.id)).toContain(created.id);

    const fav = await request.post(`${API}/favorites`, { headers: auth, data: { garmentId: garment.id } });
    expect(fav.status()).toBe(201);
    const favs = await (await request.get(`${API}/favorites`, { headers: auth })).json();
    expect(favs.map((g: { id: string }) => g.id)).toContain(garment.id);

    const prof = await request.put(`${API}/profile`, {
      headers: auth,
      data: { gender: "female", height_cm: 168, bust: 88, waist: 74, hip: 104 },
    });
    expect(prof.ok()).toBeTruthy();
    expect((await prof.json()).hip).toBe(104);

    const del = await request.delete(`${API}/me`, { headers: auth });
    expect(del.ok()).toBeTruthy();
    deleted = true;

    // Con la cuenta borrada el token ya no vale.
    expect((await request.get(`${API}/auth/me`, { headers: auth })).status()).toBe(401);
    expect((await request.post(`${API}/cart`, { headers: auth, data: { garmentId: garment.id } })).status()).toBe(401);
  } finally {
    if (!deleted) await request.delete(`${API}/me`, { headers: auth });
  }
});

test("API: POST /cart con cuerpo vacío devuelve 400", async ({ request }) => {
  const reg = await request.post(`${API}/auth/register`, { data: { email: uniqueEmail(), password: PASSWORD } });
  const { token } = await reg.json();
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const res = await request.post(`${API}/cart`, { headers: auth, data: {} });
    expect(res.status()).toBe(400);
  } finally {
    await request.delete(`${API}/me`, { headers: auth });
  }
});

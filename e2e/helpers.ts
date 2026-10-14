import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const API = "http://localhost:8787";
export const PASSWORD = "e2e-pass-123";

let seq = 0;
export const uniqueEmail = () => `e2e+${Date.now()}-${process.pid}-${seq++}@test.dev`;

/** Registra por la UI y espera a que cargue el estudio. */
export async function registerViaUI(page: Page, email = uniqueEmail(), password = PASSWORD) {
  await page.goto("/");
  await page.getByRole("button", { name: "Crear cuenta" }).first().click();
  await page.getByPlaceholder("Tu nombre").fill("Tester E2E");
  await page.getByPlaceholder("tu@email.com").fill(email);
  await page.getByPlaceholder("6+ caracteres").fill(password);
  await page.locator("form.auth-form button[type=submit]").click();
  await expect(page.locator("header.topbar .logo")).toContainText("croma");
  return { email, password };
}

/** Inicia sesión por la UI con una cuenta existente. */
export async function loginViaUI(page: Page, email: string, password = PASSWORD) {
  await page.goto("/");
  await page.getByPlaceholder("tu@email.com").fill(email);
  await page.getByPlaceholder("6+ caracteres").fill(password);
  await page.locator("form.auth-form button[type=submit]").click();
  await expect(page.locator("header.topbar .logo")).toContainText("croma");
}

/** Borra la cuenta del usuario logueado en la página (limpieza best-effort). */
export async function deleteAccountFromPage(page: Page, request: APIRequestContext) {
  try {
    const token = await page.evaluate(() => localStorage.getItem("croma_token"));
    if (token) await request.delete(`${API}/me`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    /* la página ya puede estar cerrada */
  }
}

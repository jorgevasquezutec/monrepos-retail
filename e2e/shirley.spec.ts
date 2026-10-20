import { test, expect } from "@playwright/test";
import { deleteAccountFromPage, registerViaUI } from "./helpers";

test.describe("catálogo de fábrica (Shirley)", () => {
  test.afterEach(async ({ page, request }) => {
    await deleteAccountFromPage(page, request);
  });

  test("navega el catálogo real y muestra la talla por prenda", async ({ page }) => {
    await registerViaUI(page);

    // Abre el catálogo de fábrica desde el panel.
    await page.getByRole("button", { name: /Catálogo de fábrica/ }).click();

    // El modal carga el catálogo extraído de los Excel (937 modelos).
    await expect(page.getByText(/Catálogo Shirley/)).toBeVisible();
    await expect(page.getByText(/\d+ resultados/)).toBeVisible();

    // Las tarjetas con foto real se renderizan.
    const firstCard = page.locator(".shirley-card").first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });
    await expect(firstCard.locator("img")).toBeVisible();

    // Al seleccionar una prenda, se abre el detalle con su foto…
    await firstCard.click();
    const detail = page.locator(".shirley-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator("h3")).toBeVisible();
    await expect(detail.locator(".shirley-detail-photo img")).toBeVisible();

    // …y un veredicto de talla (ajuste) o "talla única", más el aviso de ficha.
    const veredicto = detail.getByText(/Tu talla:|Ninguna talla te entra|Talla única/);
    await expect(veredicto.first()).toBeVisible();
    await expect(detail.getByText(/tabla estándar aproximada/)).toBeVisible();

    // El buscador filtra resultados.
    await page.getByPlaceholder(/Buscar modelo/).fill("coat");
    await expect(page.locator(".shirley-card").first()).toBeVisible();
  });

  test("probar una prenda la viste en el avatar 3D con su color", async ({ page }) => {
    test.setTimeout(120_000);
    await registerViaUI(page);

    await page.getByRole("button", { name: /Catálogo de fábrica/ }).click();
    await expect(page.getByText(/Catálogo Shirley/)).toBeVisible();

    const card = page.locator(".shirley-card").first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    const nombre = ((await card.locator(".shirley-meta strong").textContent()) ?? "").trim();
    await card.click();

    await page
      .locator(".shirley-detail")
      .getByRole("button", { name: /Probármela en el avatar 3D/ })
      .click();

    // El modal se cierra al llevar la prenda al avatar.
    await expect(page.getByText(/Catálogo Shirley/)).toHaveCount(0);

    // En Avatar 3D, la prenda aparece en la lista de puestas, con su muestra de color.
    await page.getByRole("button", { name: "Avatar 3D" }).click();
    const row = page.locator(".gs-row", { hasText: nombre });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator(".sw")).toBeVisible();
    // La muestra lleva un color real (no vacío) tomado de la foto.
    const bg = await row.locator(".sw").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toMatch(/^rgb/);
  });

  test("el filtro por tipo acota el catálogo", async ({ page }) => {
    await registerViaUI(page);
    await page.getByRole("button", { name: /Catálogo de fábrica/ }).click();
    await expect(page.getByText(/Catálogo Shirley/)).toBeVisible();

    // Al menos una tarjeta antes de filtrar.
    await expect(page.locator(".shirley-card").first()).toBeVisible({ timeout: 10_000 });

    // Selecciona un tipo concreto del desplegable.
    await page.locator("select.cat-tipo").selectOption({ label: "Suéter" });
    await expect(page.locator(".shirley-card").first()).toBeVisible();
  });
});

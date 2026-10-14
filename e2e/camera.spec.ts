import { test, expect } from "@playwright/test";
import { deleteAccountFromPage, registerViaUI } from "./helpers";

test.describe("cámara (probador en vivo)", () => {
  test.afterEach(async ({ page, request }) => {
    await deleteAccountFromPage(page, request);
  });

  test("modo Cámara muestra canvas y estado sin error de permisos", async ({ page }) => {
    await registerViaUI(page);

    await page.getByRole("button", { name: "Cámara", exact: true }).click();

    const canvas = page.getByTestId("live-tryon-canvas");
    await expect(canvas).toBeVisible();

    // El estado debe llegar a un valor final (el modelo de pose se descarga del CDN).
    const status = page.getByTestId("live-tryon-status");
    await expect(status).toHaveText(/Sin persona detectada|Seguimiento activo/, { timeout: 30_000 });

    // El canvas toma la resolución real del vídeo (no los 300x150 por defecto).
    await expect
      .poll(() => canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height]))
      .not.toEqual([300, 150]);
    const [w, h] = await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    const box = await canvas.boundingBox();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });
});

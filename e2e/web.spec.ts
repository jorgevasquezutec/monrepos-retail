import { test, expect } from "@playwright/test";
import { deleteAccountFromPage, registerViaUI } from "./helpers";

test.describe("web", () => {
  test.afterEach(async ({ page, request }) => {
    await deleteAccountFromPage(page, request);
  });

  test("registro por UI, preset Pera y avatar 3D", async ({ page }) => {
    // Generar el cuerpo con Blender puede tardar (servicio real): deja margen.
    test.setTimeout(120_000);
    // Registra los contextos WebGL que se crean en la página (sin crear ninguno propio).
    await page.addInitScript(() => {
      const w = window as unknown as { __gl: unknown[] };
      w.__gl = [];
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...a: unknown[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (orig as any).call(this, type, ...a);
        if (ctx && /webgl/.test(type) && !w.__gl.includes(ctx)) w.__gl.push(ctx);
        return ctx;
      } as typeof orig;
    });
    await registerViaUI(page);

    await page.getByRole("button", { name: "Avatar 3D" }).click();
    await page.getByRole("button", { name: "Pera", exact: true }).click();

    await expect(page.locator("#m-bust")).toHaveValue("88");
    await expect(page.locator("#m-waist")).toHaveValue("74");
    await expect(page.locator("#m-hip")).toHaveValue("104");

    // Canvas WebGL: el renderer de Three crea un contexto webgl vivo (registrado por el init script).
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __gl: WebGLRenderingContext[] }).__gl.some((gl) => !gl.isContextLost()),
        ),
      )
      .toBe(true);

    // Servicio de cuerpo: el destino (túnel local, LAN o host remoto) depende del
    // entorno (VITE_AVATAR_SERVICE), así que no sondeamos una URL fija. El flujo
    // debe resolverse de UNA de dos formas: el avatar se genera (botón Regenerar)
    // o la UI muestra el error. Basta con que aparezca cualquiera de los dos.
    await expect(
      page
        .getByRole("button", { name: /Regenerar con estas medidas/ })
        .or(page.getByText(/No pudimos generar/)),
    ).toBeVisible({ timeout: 90_000 });
  });
});

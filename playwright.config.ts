import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }]],
  outputDir: "e2e/.results",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["camera"],
        launchOptions: {
          args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
        },
      },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @retail/api start",
      url: "http://localhost:8787/health",
      reuseExistingServer: !process.env.CI,
      // BD en memoria: nueva en cada ejecución, sin archivos que limpiar.
      // Si ya hay un API en :8787 se reutiliza (con su BD real).
      env: { PORT: "8787", DB_PATH: ":memory:", JWT_SECRET: "e2e-secret" },
      timeout: 60_000,
    },
    {
      command: "pnpm --filter @retail/web dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      env: { BROWSER: "none" },
      timeout: 60_000,
    },
  ],
});

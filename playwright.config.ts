import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["line"], ["html", { open: "never", outputFolder: "output/playwright/report" }]] : "list",
  outputDir: "output/playwright/results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: "pnpm --dir apps/web dev --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    }
  ]
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e-runtime",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["line"], ["html", { open: "never", outputFolder: "output/playwright/runtime-report" }]] : "list",
  outputDir: "output/playwright/runtime-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:8790",
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "corepack pnpm@11.7.0 --dir apps/web build && corepack pnpm@11.7.0 exec wrangler pages dev apps/web/dist --port 8790 --show-interactive-dev-session false",
    url: "http://127.0.0.1:8790",
    reuseExistingServer: false,
    timeout: 180_000
  }
});

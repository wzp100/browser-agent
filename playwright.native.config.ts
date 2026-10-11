import { defineConfig, devices } from "@playwright/test";

/** Native bridge E2E uses a real loopback daemon and must never retain traces containing tokens. */
export default defineConfig({
  testDir: "./tests/e2e-native",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["line"], ["html", { open: "never", outputFolder: "output/playwright/native-report" }]] : "list",
  outputDir: "output/playwright/native-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4174",
    locale: "zh-CN",
    trace: "off",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 120_000
  }
});

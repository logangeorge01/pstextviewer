const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    channel: 'msedge',
    headless: true,
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true
  }
});

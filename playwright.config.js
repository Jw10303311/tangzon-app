// Lightweight smoke checks for the packaged HTML shell.
module.exports = {
  testDir: './tests',
  timeout: 30000,
  use: {
    headless: true,
    viewport: { width: 1366, height: 900 }
  }
};

import { chromium } from '@playwright/test';

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'https://matchaphone-d5gjgy87ybfb50382-1463048417.tcloudbaseapp.com';
const routes = ['/', '/messages/chats', '/settings', '/meet', '/couple-island', '/messages/browser-test-conversation'];
const viewports = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'narrow', width: 360, height: 800 },
  { name: 'landscape', width: 844, height: 390 },
];
const failures = [];
const cacheBust = `codex_pw_${Date.now()}`;
function recordFailure(kind, details) { failures.push({ kind, ...details }); }

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'allow', locale: 'zh-CN' });
  try {
    for (const viewport of viewports) {
      const page = await context.newPage({ viewport });
      const pageErrors = [];
      const failedRequests = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
      page.on('requestfailed', (request) => {
        const failure = request.failure();
        failedRequests.push({ url: request.url(), errorText: failure?.errorText ?? 'unknown' });
      });

      for (const route of routes) {
        const url = new URL(route, baseUrl);
        url.searchParams.set('pw', cacheBust);
        const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
        if (!response || !response.ok()) {
          recordFailure('http', { viewport: viewport.name, route, status: response?.status() ?? 0 });
          continue;
        }
        await page.waitForTimeout(500);
        const metrics = await page.evaluate(() => ({
          bodyText: document.body?.innerText?.trim().slice(0, 200) ?? '',
          bodyWidth: document.body?.scrollWidth ?? 0,
          viewportWidth: document.documentElement?.clientWidth ?? 0,
          visibleText: Boolean(document.body?.innerText?.trim()),
        }));
        if (!metrics.visibleText || metrics.bodyWidth > metrics.viewportWidth + 1) {
          recordFailure('layout', { viewport: viewport.name, route, metrics });
        }
      }

      if (pageErrors.length) recordFailure('console', { viewport: viewport.name, errors: pageErrors });
      if (failedRequests.length) recordFailure('request', { viewport: viewport.name, requests: failedRequests });
      await page.close();
    }
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ baseUrl, routes, viewports, checkedAt: new Date().toISOString(), failures }, null, 2));
if (failures.length) process.exitCode = 1;

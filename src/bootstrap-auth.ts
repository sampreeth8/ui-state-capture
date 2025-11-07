// src/bootstrap-auth.ts
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

function waitForEnter(msg: string) {
  return new Promise<void>((resolve) => {
    process.stdout.write(msg);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

(async () => {
  const app = process.argv[2] ?? 'linear';
  const outPath = path.join('auth', `${app}.json`);
  fs.mkdirSync('auth', { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`\nOpen login for app: ${app}`);
  // const startUrl = app === 'notion' ? 'https://www.notion.so/login' : 'https://linear.app/login';
  const startUrl =
  app === 'notion'
    ? 'https://www.notion.so/login'
    : app === 'asana'
    ? 'https://app.asana.com/login'
    : 'https://linear.app/login';

  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  console.log(`
1) Manually log in in the opened browser window.
2) When you reach your workspace/home page (not the /login page), return to this terminal.
`);
  await waitForEnter('Press ENTER here after you are fully logged in… ');

  await context.storageState({ path: outPath });
  console.log(`Saved storage state to ${outPath}`);
  await browser.close();
})();

import { chromium } from 'playwright';
const OPT = 'div:nth-of-type(4)';
const lab = (i, l) => `${OPT} > div:nth-of-type(${i}) > div:nth-of-type(2) > div > div:nth-of-type(${l}) > input`;
const ctx = await chromium.launchPersistentContext(process.env.HOME + '/demo-engine/chrome-profile', { headless: true, executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
const p = ctx.pages()[0] || await ctx.newPage();
await p.goto('https://turg.fitness.ee/admin/engagement/widgets/new', { waitUntil: 'networkidle' });
for (const [i, t] of [[1,'3 grammi'],[2,'5 grammi'],[3,'10 grammi'],[4,'20 grammi']]) {
  const el = p.locator(lab(i,1));
  console.log('opt', i, 'count', await el.count());
  if (await el.count() === 1) await el.fill(t);
}
console.log('explanation count', await p.locator('div:nth-of-type(5) > div:nth-of-type(1) > div:nth-of-type(1) > textarea').count());
console.log('src type count', await p.locator('div:nth-of-type(5) > div:nth-of-type(3) > div:nth-of-type(1) > select').count());
console.log('src ref count', await p.locator('div:nth-of-type(5) > div:nth-of-type(3) > div:nth-of-type(2) > input').count());
await p.screenshot({ path: '/tmp/form.png', fullPage: false });
await ctx.close();

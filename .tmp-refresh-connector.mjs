// Refresh the MaxFit connector in ChatGPT settings using the demo Chrome profile.
// Exploratory: screenshots + text dumps at each step so failures are diagnosable.
import { chromium } from "playwright";
import { homedir } from "os";
import { join } from "path";

const SCRATCH = "/private/tmp/claude-501/-Users-tandryukha-dropshipping-irondust/28e9fb1d-cf91-4e67-84bc-f1eea52be036/scratchpad";
const PROFILE = join(homedir(), "demo-engine", "chrome-profile");

const shot = async (page, name) => {
  await page.screenshot({ path: join(SCRATCH, `refresh-${name}.png`) }).catch(() => {});
  console.log(`[shot] ${name}`);
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await shot(page, "01-home");

  const composer = page.locator("#prompt-textarea");
  if (!(await composer.count())) {
    console.log("NOT LOGGED IN (no composer). Aborting.");
    process.exit(2);
  }
  console.log("logged in: composer present");

  // Try settings deep links first.
  let onSettings = false;
  for (const anchor of ["#settings/Connectors", "#settings/Apps", "#settings"]) {
    await page.goto(`https://chatgpt.com/${anchor}`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2500);
    const dialogText = await page.locator('[role="dialog"]').first().textContent().catch(() => null);
    if (dialogText) {
      console.log(`settings dialog open via ${anchor}; text head: ${dialogText.slice(0, 200)}`);
      onSettings = true;
      break;
    }
  }
  if (!onSettings) {
    // Fallback: click the profile/account button then Settings.
    console.log("deep links failed; trying menu route");
    await page.locator('[data-testid="profile-button"], [data-testid="accounts-profile-button"]').first().click({ timeout: 5000 });
    await page.waitForTimeout(1000);
    await shot(page, "02-menu");
    await page.getByText(/^Settings$/).first().click({ timeout: 5000 });
    await page.waitForTimeout(2000);
  }
  await shot(page, "03-settings");

  // Find the Apps & Connectors tab inside the settings dialog.
  const dialog = page.locator('[role="dialog"]').first();
  const tab = dialog.getByText(/Apps & Connectors|Connectors|Apps/i).first();
  if (await tab.count()) {
    await tab.click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  await shot(page, "04-connectors-tab");
  const tabText = await dialog.textContent().catch(() => "");
  console.log("connectors panel text head:", (tabText || "").slice(0, 400));

  // Open the MaxFit connector entry.
  const maxfit = dialog.getByText(/MaxFit/i).first();
  await maxfit.click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  await shot(page, "05-maxfit-detail");
  const detailText = await page.locator('[role="dialog"]').last().textContent().catch(() => "");
  console.log("maxfit detail text:", (detailText || "").slice(0, 1500));

  // Click Refresh.
  const refreshBtn = page.locator('[role="dialog"]').last().getByText(/^Refresh$/i).first();
  await refreshBtn.click({ timeout: 8000 });
  console.log("clicked Refresh");
  await page.waitForTimeout(5000);
  await shot(page, "06-after-refresh");
  const afterText = await page.locator('[role="dialog"]').last().textContent().catch(() => "");
  console.log("after refresh text:", (afterText || "").slice(0, 2500));
} catch (e) {
  console.error("FAILED:", e.message);
  await shot(page, "99-failure");
  process.exitCode = 1;
} finally {
  await ctx.close();
}

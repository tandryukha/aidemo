// Verify the MaxFit connector lists all 11 tools; re-click Refresh if not.
import { chromium } from "playwright";
import { homedir } from "os";
import { join } from "path";
import { writeFileSync } from "fs";

const SCRATCH = "/private/tmp/claude-501/-Users-tandryukha-dropshipping-irondust/28e9fb1d-cf91-4e67-84bc-f1eea52be036/scratchpad";
const PROFILE = join(homedir(), "demo-engine", "chrome-profile");
const NEW_TOOLS = ["compare_products", "get_order_status", "get_delivery_options", "clear_cart"];

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

const dumpTools = async () => {
  const text = (await page.locator('[role="dialog"]').last().textContent().catch(() => "")) || "";
  writeFileSync(join(SCRATCH, "connector-detail.txt"), text);
  const missing = NEW_TOOLS.filter((t) => !text.includes(t));
  return { text, missing };
};

try {
  await page.goto("https://chatgpt.com/#settings", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.getByText(/^Apps$/).first().click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(SCRATCH, "connector-apps-panel.png") });
  await page.locator('[role="dialog"]').last().getByText(/MaxFit/i).first().click({ timeout: 10000 });
  await page.waitForTimeout(2500);

  let { missing } = await dumpTools();
  console.log(missing.length ? `MISSING: ${missing.join(",")}` : "ALL NEW TOOLS PRESENT");

  if (missing.length) {
    const refreshBtn = page.locator('[role="dialog"]').last().getByText(/^Refresh/i).first();
    await refreshBtn.click({ timeout: 8000 });
    console.log("clicked Refresh, waiting 20s");
    await page.waitForTimeout(20000);
    ({ missing } = await dumpTools());
    console.log(missing.length ? `STILL MISSING: ${missing.join(",")}` : "ALL NEW TOOLS PRESENT AFTER REFRESH");
  }
  await page.screenshot({ path: join(SCRATCH, "connector-verify.png") });
} catch (e) {
  console.error("FAILED:", e.message);
  await page.screenshot({ path: join(SCRATCH, "connector-verify-fail.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await ctx.close();
}

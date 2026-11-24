// --chrome-profile: clone filter, spec parsing and launch flags. No Chrome needed.
//   npx tsx --test test/chrome-profile.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloneChromeProfile, parseChromeProfile, MOCK_KEYCHAIN_ARGS } from "../src/chrome-profile.ts";

test("parseChromeProfile: bare flag and 'default' mean the default dir", () => {
  delete process.env.AIDEMO_CHROME_PROFILE_FROM;
  assert.equal(parseChromeProfile(undefined), undefined);
  assert.deepEqual(parseChromeProfile(true, "Profile 1"), { source: "default", profileDirectory: "Profile 1" });
  assert.equal(parseChromeProfile("default")?.source, "default");
  assert.equal(parseChromeProfile("/x/y")?.source, "/x/y");
});

test("cloneChromeProfile copies the profile minus caches, drops mock-keychain flags, and cleans up", async () => {
  const src = mkdtempSync(join(tmpdir(), "cp-src-"));
  writeFileSync(join(src, "Local State"), "{}");
  const prof = join(src, "Profile 1");
  for (const d of ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage", "IndexedDB"]) mkdirSync(join(prof, d), { recursive: true });
  writeFileSync(join(prof, "Cookies"), "x");
  writeFileSync(join(prof, "Cache", "big"), "x");
  writeFileSync(join(prof, "Service Worker", "CacheStorage", "big"), "x");
  writeFileSync(join(prof, "IndexedDB", "keep"), "x");
  const c = await cloneChromeProfile({ source: src, profileDirectory: "Profile 1" });
  try {
    assert.ok(existsSync(join(c.dir, "Local State")));
    assert.ok(existsSync(join(c.dir, "Profile 1", "Cookies")));
    assert.ok(existsSync(join(c.dir, "Profile 1", "IndexedDB", "keep")));
    assert.ok(!existsSync(join(c.dir, "Profile 1", "Cache")));
    assert.ok(!existsSync(join(c.dir, "Profile 1", "Service Worker", "CacheStorage")));
    assert.deepEqual(c.launch.ignoreDefaultArgs, MOCK_KEYCHAIN_ARGS);
    assert.deepEqual(c.launch.args, ["--profile-directory=Profile 1"]);
  } finally {
    await c.cleanup();
  }
  assert.ok(!existsSync(c.dir));
});

test("cloneChromeProfile names the available profiles when the folder is missing", async () => {
  const src = mkdtempSync(join(tmpdir(), "cp-src-"));
  mkdirSync(join(src, "Default"));
  await assert.rejects(cloneChromeProfile({ source: src, profileDirectory: "Profile 9" }), /Default/);
});

test("'own' is a persistent profile: not a copy, real keychain flags, cleanup keeps it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-own-"));
  process.env.AIDEMO_OWN_CHROME_PROFILE = dir;
  assert.equal(parseChromeProfile("own")?.source, "own");
  const c = await cloneChromeProfile({ source: "own" });
  assert.equal(c.dir, dir);
  assert.equal(c.persistent, true);
  assert.deepEqual(c.launch.ignoreDefaultArgs, MOCK_KEYCHAIN_ARGS);
  await c.cleanup();
  assert.ok(existsSync(dir));
  delete process.env.AIDEMO_OWN_CHROME_PROFILE;
});

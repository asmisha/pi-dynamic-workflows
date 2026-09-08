/**
 * Tests for model-tier-config.ts
 *
 * Covers:
 * 1. buildDefaultTierConfig — all tiers default to the given model
 * 2. resolveTierModel logic
 * 3. save/load round-trip + all validation/error paths (scoped to a temp dir)
 * 4. sortedTierNames helper
 *
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

async function loadModule() {
  return await import("../src/model-tier-config.js");
}

describe("model-tier-config", () => {
  describe("buildDefaultTierConfig", () => {
    it("sets every tier to the provided current model", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1");
      assert.deepEqual(cfg.tiers, {
        small: "openai/gpt-4.1",
        medium: "openai/gpt-4.1",
        big: "openai/gpt-4.1",
      });
    });

    it("each tier holds a single string", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1");
      for (const [name, model] of Object.entries(cfg.tiers)) {
        assert.equal(typeof model, "string", `${name} tier should hold a string`);
      }
    });

    it("always produces the three standard tiers", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const cfg = buildDefaultTierConfig("openai/gpt-4.1");
      assert.deepEqual(Object.keys(cfg.tiers).sort(), ["big", "medium", "small"]);
    });
  });

  describe("resolveTierModel", () => {
    it("returns the model for a valid tier", async () => {
      const { resolveTierModel } = await loadModule();
      const config = {
        tiers: { small: "openai/gpt-4.1-mini", medium: "openai/gpt-4.1", big: "openai/gpt-5" },
      };
      assert.equal(resolveTierModel("small", config), "openai/gpt-4.1-mini");
      assert.equal(resolveTierModel("medium", config), "openai/gpt-4.1");
      assert.equal(resolveTierModel("big", config), "openai/gpt-5");
    });

    it("returns undefined for unknown tier name", async () => {
      const { resolveTierModel } = await loadModule();
      assert.equal(resolveTierModel("nonexistent", { tiers: { small: "gpt-4.1-mini" } }), undefined);
    });

    it("returns empty string when tier exists but no model is assigned", async () => {
      const { resolveTierModel } = await loadModule();
      assert.equal(resolveTierModel("medium", { tiers: { small: "gpt-4.1-mini", medium: "" } }), "");
    });
  });

  describe("loadModelTierConfig / saveModelTierConfig (scoped to tmpdir)", () => {
    it("round-trips a valid config through disk", async () => {
      const { loadModelTierConfig, saveModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      const config = {
        tiers: { small: "gpt-4.1-mini", medium: "gpt-4.1", big: "gpt-5" },
      };
      saveModelTierConfig(config, cfgPath);
      const loaded = loadModelTierConfig(cfgPath);
      assert.deepEqual(loaded, config);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when file does not exist", async () => {
      const { loadModelTierConfig } = await loadModule();
      assert.equal(loadModelTierConfig(join(tmpdir(), "nonexistent-test-file.json")), null);
    });

    it("returns null for corrupted JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, "{invalid json", "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null for non-object JSON", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '"just a string"', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when tiers is not an object", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": "not-an-object"}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when a tier value is not a string", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": ["gpt-4.1-mini"]}}', "utf-8");
      assert.equal(loadModelTierConfig(cfgPath), null, "array values should be rejected");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("accepts a config where a tier value is a valid string", async () => {
      const { loadModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      writeFileSync(cfgPath, '{"tiers": {"small": "gpt-4.1-mini"}}', "utf-8");
      const result = loadModelTierConfig(cfgPath);
      assert.equal(result?.tiers.small, "gpt-4.1-mini");
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("sortedTierNames", () => {
    it("returns names sorted: small < medium < big", async () => {
      const { sortedTierNames } = await loadModule();
      const config = { tiers: { big: "gpt-5", small: "gpt-4.1-mini", medium: "gpt-4.1" } };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "big"]);
    });

    it("places custom tier names alphabetically after the standard ones", async () => {
      const { sortedTierNames } = await loadModule();
      const config = { tiers: { xlarge: "gpt-5", medium: "gpt-4.1", small: "gpt-4.1-mini" } };
      assert.deepEqual(sortedTierNames(config), ["small", "medium", "xlarge"]);
    });
  });
});

it("round trips mixed tier entries and validates object effort", async () => {
  const { loadModelTierConfig, saveModelTierConfig, resolveTierModel } = await loadModule();
  const dir = mkdtempSync(join(tmpdir(), "tier-thinking-"));
  const path = join(dir, "nested", "tiers.json");
  try {
    for (const thinking of ["low", "medium", "high", "xhigh", "max"] as const) {
      const config = {
        tiers: { small: "legacy", medium: { model: "provider/astra", thinking }, big: { model: "provider/astra" } },
      };
      saveModelTierConfig(config, path);
      assert.deepEqual(loadModelTierConfig(path), config);
      assert.equal(resolveTierModel("medium", config), "provider/astra");
    }
    for (const entry of [
      null,
      [],
      {},
      { thinking: "low" },
      { model: 5 },
      { model: "m", thinking: "off" },
      { model: "m", thinking: null },
      { model: "m", thinking: "ultra" },
    ]) {
      writeFileSync(path, JSON.stringify({ tiers: { medium: entry } }));
      assert.equal(loadModelTierConfig(path), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

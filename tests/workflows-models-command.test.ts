/**
 * Tests for workflows-models-command.ts
 *
 * Since pi.registerCommand and ctx.ui functions are only available at runtime
 * inside Pi, these tests focus on the pure logic: command creation,
 * the editSingleTier single-select helper, and integration with model-tier-config.
 *
 * editSingleTier now uses ctx.ui.custom() with SelectList.
 * In tests, we mock ctx.ui.custom to directly return the expected value.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

async function loadCommand() {
  const mod = await import("../src/workflows-models-command.js");
  return mod;
}

describe("workflows-models-command", () => {
  describe("registerWorkflowModelsCommand", () => {
    it("registers the workflows-models command with Pi", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      const commands: string[] = [];
      const mockPi = {
        registerCommand: mock.fn((name: string, _opts: unknown) => {
          commands.push(name);
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);

      assert.equal(mockPi.registerCommand.mock.callCount(), 1);
      assert.equal(commands[0], "workflows-models");
    });

    it("provides a description", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      let capturedDescription = "";

      const mockPi = {
        registerCommand: mock.fn((_name: string, opts: { description?: string }) => {
          capturedDescription = opts.description ?? "";
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);
      assert.ok(capturedDescription.length > 0, "description should not be empty");
      assert.ok(capturedDescription.toLowerCase().includes("tier"), "description should mention tiers");
    });
  });

  describe("editSingleTier", () => {
    it("exports editSingleTier function", async () => {
      const mod = await import("../src/workflows-models-command.js");
      assert.equal(typeof mod.editSingleTier, "function");
    });

    it("returns null when user presses Escape (done with null)", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      // Mock ctx.ui.custom to return null (simulating user cancelling)
      const ctx = {
        ui: {
          custom: mock.fn(async () => null),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.equal(result, null);
    });

    it("returns null when user selects the same model (no change)", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      // Mock ctx.ui.custom to return the same model that's already selected
      const ctx = {
        ui: {
          custom: mock.fn(async () => "gpt-4.1-mini"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.equal(result, null); // no change
    });

    it("selects a different model and returns updated tiers", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      // Mock ctx.ui.custom to return a different model
      const ctx = {
        ui: {
          custom: mock.fn(async () => "gpt-5"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = { small: "gpt-4.1-mini" };

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.equal(result.small, "gpt-5", "should have changed model");
      assert.equal(typeof result.small, "string", "should still be a string");
    });

    it("selects a model when no current model exists", async () => {
      const { editSingleTier } = await import("../src/workflows-models-command.js");
      const ctx = {
        ui: {
          custom: mock.fn(async () => "openai/gpt-4.1-mini"),
          notify: mock.fn(),
        },
      };
      const tiers: Record<string, string> = {};

      const result = await editSingleTier(ctx as never, tiers, "small");
      assert.ok(result, "should return updated tiers");
      assert.equal(result.small, "openai/gpt-4.1-mini");
    });
  });
});

it("model edits retain tier thinking and do not mutate the input", async () => {
  const { editSingleTier } = await loadCommand();
  const tiers = { medium: { model: "old/model", thinking: "low" as const }, small: "legacy" };
  const ctx = { ui: { custom: async () => "new/model", notify: () => {} } };
  assert.deepEqual(await editSingleTier(ctx as never, tiers, "medium"), {
    medium: { model: "new/model", thinking: "low" },
    small: "legacy",
  });
  assert.equal(tiers.medium.model, "old/model");
});

it("command displays, edits, saves, and clears tier thinking", async () => {
  const { loadModelTierConfig, saveModelTierConfig } = await import("../src/model-tier-config.js");
  const { registerWorkflowModelsCommand } = await loadCommand();
  const home = mkdtempSync(join(tmpdir(), "tier-ui-"));
  try {
    await withFakeHomeAsync(home, async () => {
      saveModelTierConfig({ tiers: { medium: { model: "provider/astra", thinking: "low" } } });
      let handler = async (_args: string, _ctx: any) => {};
      registerWorkflowModelsCommand({
        registerCommand: (_name: string, opts: any) => {
          handler = opts.handler;
        },
      } as never);
      for (const level of ["medium", "Session default"]) {
        let call = 0;
        await handler("", {
          waitForIdle: async () => {},
          ui: {
            select: async (_title: string, options: string[]) => {
              call++;
              if (call === 1) {
                assert.ok(options.some((option) => option.includes("provider/astra")));
                assert.ok(options.includes(`medium thinking → ${level === "medium" ? "low" : "medium"}`));
                assert.ok(!options.some((option) => option.includes("[object Object]")));
                return options.find((option) => option.startsWith("medium thinking →"));
              }
              if (call === 2) {
                assert.ok(options.includes(level));
                return level;
              }
              return "Save and exit";
            },
            notify: () => {},
          },
        });
        assert.deepEqual(
          loadModelTierConfig()?.tiers.medium,
          level === "Session default" ? "provider/astra" : { model: "provider/astra", thinking: "medium" },
        );
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

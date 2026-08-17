import assert from "node:assert/strict";
import test from "node:test";
import { workflowOutcome } from "../src/workflow-outcome.js";

test("workflowOutcome extracts valid top-level and continuation outcomes", () => {
  assert.equal(workflowOutcome({ outcome: "completed_with_warnings" }), "completed_with_warnings");
  assert.equal(workflowOutcome({ continuationState: { outcome: "blocked" } }), "blocked");
  assert.equal(workflowOutcome({ outcome: "failed", continuationState: { outcome: "blocked" } }), "failed");
});

test("workflowOutcome returns undefined when the outcome is missing", () => {
  assert.equal(workflowOutcome(undefined), undefined);
  assert.equal(workflowOutcome({}), undefined);
  assert.equal(workflowOutcome({ continuationState: {} }), undefined);
});

test("workflowOutcome rejects malformed outcomes", () => {
  for (const value of [
    { outcome: "Blocked" },
    { outcome: "has spaces" },
    { outcome: "" },
    { outcome: `a${"b".repeat(64)}` },
    { outcome: 1 },
    { continuationState: [] },
    { continuationState: { outcome: "not.valid" } },
  ]) {
    assert.equal(workflowOutcome(value), undefined);
  }
});

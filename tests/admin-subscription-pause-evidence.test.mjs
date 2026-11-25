import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionPauseEvidence } from "../lib/adminSubscriptionsQuery.ts";

test("Admin pause evidence distinguishes empty, missing, pending and contradictory data", () => {
  const id = "subscription-a";
  const window = { subscription_id: id, pause_at: "2026-11-30T12:00:00Z" };
  assert.deepEqual(subscriptionPauseEvidence(null, id), { state: "unknown" });
  assert.equal(subscriptionPauseEvidence({ windows: [], fences: [] }, id), null);
  assert.deepEqual(subscriptionPauseEvidence({ windows: [window], fences: [] }, id),
    { state: "window", at: window.pause_at });
  assert.deepEqual(subscriptionPauseEvidence({ windows: [window], fences: [{ subscription_id: id, action: "resume" }] }, id),
    { state: "resume" });
  assert.deepEqual(subscriptionPauseEvidence({ windows: [window, window], fences: [] }, id), { state: "conflict" });
  assert.deepEqual(subscriptionPauseEvidence({ windows: [{ ...window, pause_at: "invalid" }], fences: [] }, id),
    { state: "unknown" });
  assert.equal(subscriptionPauseEvidence({ windows: [window], fences: [] }, "subscription-b"), null);
});

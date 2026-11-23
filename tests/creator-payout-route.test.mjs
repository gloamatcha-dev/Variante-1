import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const creatorId = "10000000-0000-4000-8000-000000000001";
const operationId = "10000000-0000-4000-8000-000000000002";
const documentId = "10000000-0000-4000-8000-000000000003";

test("creator payout actions and internal export are owner-only and require real evidence fields", async () => {
  const code = ts.transpileModule(readFileSync(new URL("../app/api/admin/creators/payouts/route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  const calls = [];
  let role = "admin";
  vm.runInNewContext(code, {
    module, exports: module.exports, Response, URL,
    require(name) {
      if (name.includes("adminActionRoute")) return { openAdminAction: async request => ({
        ok: true, context: { identity: { role, userId: "owner" }, body: await request.json() },
      }) };
      if (name.includes("adminPortalModel")) return { uuid: value => [creatorId, operationId, documentId].includes(value) };
      if (name.includes("supabaseAdmin")) return { getSupabaseAdmin: () => ({
        rpc: async (name, args) => {
          calls.push({ name, args });
          return { data: { taxDocumentAvailable: false, positions: [{ cents: 250 }] } };
        },
      }) };
      throw Error(name);
    },
  });
  const call = (values, origin = "https://local.invalid") => module.exports.POST(new Request(
    "https://local.invalid/api/admin/creators/payouts",
    { method: "POST", headers: { origin }, body: JSON.stringify({ creatorId, month: "2026-10", ...values }) },
  ));
  assert.equal((await call({ action: "approve", operationId })).status, 403);
  role = "owner";
  assert.equal((await call({ action: "read" }, "https://foreign.invalid")).status, 403);
  assert.equal((await call({ action: "paid", operationId, evidence: "synthetic" })).status, 400);
  assert.equal((await call({ action: "tax_invoice" })).status, 400);
  assert.equal(calls.length, 0);
  const paidAt = "2026-11-01T10:00:00.000Z";
  assert.equal((await call({ action: "paid", operationId, evidence: "synthetic", paidAt, documentId })).status, 200);
  assert.equal(calls[0].name, "admin_creator_payout_v1");
  assert.equal(calls[0].args.p_document, documentId);
  assert.equal(calls[0].args.p_paid_at, paidAt);
  const exported = await call({ action: "export" });
  assert.equal(exported.headers.get("cache-control"), "private, no-store");
  assert.match(exported.headers.get("content-disposition"), /^attachment/);
  const payload = await exported.json();
  assert.equal(payload.documentType, "internal_creator_payout_record");
  assert.equal(payload.taxDocumentAvailable, false);
});

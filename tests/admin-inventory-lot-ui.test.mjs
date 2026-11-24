import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(file, deps, extra = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    module, exports: module.exports, URL, Response, FormData, ...extra,
    require(name) { if (name in deps) return deps[name]; throw new Error(name); },
  });
  return module.exports;
}

const lotId = "10000000-0000-0000-0000-000000000001";
const sku = "GLOA-MATCHA-30G";
test("a search result fills a structured pick which calls only the existing pick API", async () => {
  let index = 0;
  const hooks = [];
  const requests = [];
  const element = (type, props, key) => ({ type, props, key });
  const lot = { receipt_id: lotId, lot_code: "SYNTHETIC", sku, remaining_quantity: 2,
    received_quantity: 2, blocked: false, eligible: true, best_before: "2027-01-01", occurred_at: "2026-11-24" };
  const panel = load("../app/AdminInventoryLots.tsx", {
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "fragment" },
    react: {
      useState(initial) {
        const i = index++;
        if (!(i in hooks)) hooks[i] = initial;
        return [hooks[i], value => { hooks[i] = typeof value === "function" ? value(hooks[i]) : value; }];
      },
      useRef(initial) {
        const i = index++;
        return hooks[i] ??= { current: initial };
      },
    },
    "./AdminPortalShared": { async portalRequest(endpoint, input) {
      requests.push([endpoint, input]);
      return { lots: [lot], sources: [], shipments: [], history: [], corrections: [] };
    } },
  }, { FormData: class { get() { return "TEST-ORDER"; } } });
  const render = () => { index = 0; return panel.AdminInventoryLots(); };
  function nodes(tree) {
    return tree && typeof tree === "object"
      ? Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
      : [];
  }
  const all = kind => nodes(render()).filter(row => row.type === kind);
  all("input")[0].props.onChange({ target: { value: sku } });
  all("form")[0].props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const choose = all("button").find(button => button.props.children === "F\u00fcr Versand ausw\u00e4hlen");
  assert.ok(choose);
  choose.props.onClick();
  assert.equal(all("input").find(input => input.props.maxLength === 36).props.value, lotId);
  all("input").find(input => input.props.type === "number").props.onChange({ target: { value: "2" } });
  all("form").at(-1).props.onSubmit({ preventDefault() {}, currentTarget: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    ["/api/admin/inventory/lots", { action: "read", code: sku }],
    ["/api/admin/inventory/lots", { action: "pick", reference: "TEST-ORDER", sku, lines: [{ receiptId: lotId, units: 2 }] }],
  ]);
});

test("pick still requires admin authorization and server acceptance", async () => {
  let allowed = false;
  const calls = [];
  const endpoint = load("../app/api/admin/inventory/lots/route.ts", {
    "../../../../../lib/adminActionRoute.ts": { async openAdminAction(request) {
      return allowed ? { ok: true, context: { body: await request.json(), identity: { userId: "operator" } } }
        : { ok: false, response: new Response(null, { status: 403 }) };
    } },
    "../../../../../lib/adminPortalModel.ts": { uuid: id => id === lotId },
    "../../../../../lib/supabaseAdmin": { getSupabaseAdmin: () => ({ async rpc(name, args) {
      calls.push([name, args]);
      return { error: { message: "inventory_lot_pick_invalid" } };
    } }) },
  });
  const call = (lines, origin = "https://local.invalid") => endpoint.POST(new Request(
    "https://local.invalid/api/admin/inventory/lots", { method: "POST", headers: { origin },
      body: JSON.stringify({ action: "pick", reference: "TEST-ORDER", sku, lines }) },
  ));
  assert.equal((await call([{ receiptId: lotId, units: 2 }])).status, 403);
  allowed = true;
  assert.equal((await call([{ receiptId: lotId, units: 2 }], "https://foreign.invalid")).status, 403);
  assert.equal((await call([{ receiptId: lotId, units: 2.5 }])).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await call([{ receiptId: lotId, units: 2 }])).status, 409);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "admin_set_matcha_lot_pick_v1");
  assert.equal(calls[0][1].p_actor, "operator");
});

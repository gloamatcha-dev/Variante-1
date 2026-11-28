import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as finance from '../lib/financeSummary.ts';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../app/AdminCosts.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function find(node, predicate) {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  return predicate(node) ? node : find(node.props?.children, predicate);
}

test('expense filter survives invalid dates and server errors and recovers across presets', async () => {
  const requests = [], periods = [], slots = [], pending = [];
  let rejectFirst = true;
  let cursor = 0;
  const hook = (init) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = init();
    return index;
  };
  const changed = (slot, deps) => !slot.deps || deps.some((value, index) => !Object.is(value, slot.deps[index]));
  const react = {
    useState(initial) {
      const i = hook(() => typeof initial === 'function' ? initial() : initial);
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial) { return slots[hook(() => ({ current: initial }))]; },
    useCallback(callback, deps) {
      const i = hook(() => ({}));
      if (changed(slots[i], deps)) slots[i] = { callback, deps };
      return slots[i].callback;
    },
    useEffect(callback, deps) {
      const i = hook(() => ({}));
      if (changed(slots[i], deps)) pending.push(() => {
        slots[i].cleanup?.();
        slots[i] = { deps, cleanup: callback() };
      });
    },
  };
  const exports = {};
  const imports = { react, './AdminExpenseReceiptAssignment': {}, '../lib/financeSummary': finance, '../lib/adminOrdersQuery': { formatCents: String }, './AdminPortalExpenseOrder': {} };
  vm.runInNewContext(compiled, { exports, require: name => imports[name] ?? require(name), fetch: async (_, options) => {
    const { from, to } = JSON.parse(options.body);
    requests.push({ from, to });
    if (rejectFirst) {
      rejectFirst = false;
      return Response.json({ error: 'Bitte gib einen gültigen Zeitraum an.' }, { status: 400 });
    }
    return Response.json({
      ok: true, expenses: [], summary: finance.buildFinanceSummary({ period: { from, to }, expenses: [], orders: [] }),
    });
  } });
  const props = { expensesOnly: true, onSessionLost() {}, onPeriodChanged: range => periods.push({ ...range }) };
  const render = () => {
    cursor = 0;
    const tree = exports.AdminCosts(props);
    pending.splice(0).forEach(effect => effect());
    return tree;
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const picker = node => node.type === 'select' && ['this_month', 'last_month', 'year', 'custom'].includes(node.props.value);
  const select = value => {
    find(render(), picker).props.onChange({ target: { value } });
    render();
  };
  const dateInput = label => find(render(), node => node.type === 'label' && node.props.children?.[0] === label).props.children[1];
  const today = finance.berlinDateOf(new Date().toISOString());
  assert.ok(find(render(), picker));
  await settle();
  assert.ok(find(render(), node => node.props?.role === 'alert'));
  assert.ok(find(render(), picker));
  assert.deepEqual(requests[0], finance.monthPeriod(today));
  select('last_month');
  await settle();
  assert.deepEqual(requests.at(-1), finance.previousMonthPeriod(today));
  assert.ok(find(render(), node => node.type === 'td' && node.props.className === 'ops-empty'));
  select('custom');
  await settle();
  const before = requests.length;
  dateInput('Von').props.onChange({ target: { value: '' } });
  const invalid = render();
  await settle();
  assert.equal(requests.length, before);
  assert.ok(find(invalid, node => node.props?.role === 'alert'));
  assert.ok(find(invalid, node => node.type === 'table'));
  select('this_month');
  await settle();
  assert.deepEqual(requests.at(-1), finance.monthPeriod(today));
  assert.equal(find(render(), node => node.props?.role === 'alert'), undefined);
  select('year');
  await settle();
  assert.deepEqual(requests.at(-1), { from: today.slice(0,4)+'-01-01', to: today.slice(0,4)+'-12-31' });
  select('custom');
  dateInput('Von').props.onChange({ target: { value: '2024-02-29' } });
  dateInput('Bis').props.onChange({ target: { value: '2024-02-29' } });
  render();
  await settle();
  assert.deepEqual(requests.at(-1), { from: '2024-02-29', to: '2024-02-29' });
  assert.deepEqual(periods, requests);
});

test('Berlin calendar date is ISO and crosses the month at local midnight', () => {
  assert.equal(finance.berlinDateOf('2026-11-30T23:20:00Z'), '2026-12-01');
});

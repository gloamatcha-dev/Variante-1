import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('manual sync reports the invocation separately from persisted finance status', async () => {
  const source = readFileSync(new URL('../app/AdminGlobalStripeSync.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const state = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  let start;
  let run;
  const react = {
    createContext: () => ({ Provider: 'Provider' }),
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = value; }];
    },
    useRef(initial) {
      const index = refIndex++;
      return refs[index] ??= { current: initial };
    },
    useCallback: fn => fn,
    useEffect(fn) { start ??= fn; },
  };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name.includes('globalFinanceSync')) return { berlinSyncTime: () => '–' };
      throw Error(name);
    },
    window: { setInterval() {}, addEventListener() {} },
    fetch: async (_url, options) => JSON.parse(options.body).action === 'run'
      ? run() : { ok: true, json: async () => ({ ok: true, status: { state: 'complete' }, canSync: true }) },
  });
  function render() {
    stateIndex = refIndex = 0;
    return module.exports.AdminStripeSyncProvider({}).props.value.header;
  }
  function find(node, predicate) {
    if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
    if (!node?.props) return undefined;
    return predicate(node) ? node : find(node.props.children, predicate);
  }
  render();
  start();
  await new Promise(resolve => setImmediate(resolve));
  for (const [response, expected] of [
    [{ ok: true, scanCompleted: true, reconciliationVerified: true }, 'Manueller Abgleich abgeschlossen und verifiziert.'],
    [{ ok: true, scanCompleted: true }, 'Manueller Scan abgeschlossen. Der Abgleich ist noch nicht verifiziert.'],
    [{ ok: true, reconciliationVerified: true }, 'Abschluss des manuellen Abgleichs nicht bestätigt.'],
    [{ ok: false, error: 'Abgleich fehlgeschlagen.' }, 'Abgleich fehlgeschlagen.'],
  ]) {
    run = async () => ({ ok: response.ok, json: async () => response });
    find(render(), node => node.type === 'button' && node.props.className === 'portal-cta-primary').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(find(render(), node => node.props.role === 'status').props.children, expected);
  }
});

/** Local verification only: refuse every external provider/database request. */
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Local verification blocked an external network request');
  }
  return originalFetch(input, init);
};

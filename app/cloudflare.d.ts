declare interface Fetcher { fetch(input: Request | string): Promise<Response> }
declare interface D1Database { prepare(query: string): unknown }
declare module "cloudflare:workers" { export const env: { DB?: D1Database } }

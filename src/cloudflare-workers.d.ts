// adapter-cloudflare 8 resolves `cloudflare:workers` (natively in production, through
// a platform proxy in `vite dev`). Only `env` is used, typed by the global `Env` in
// env.d.ts. Pulling in all of @cloudflare/workers-types globally would replace the
// DOM `Response` types the client code relies on.
declare module 'cloudflare:workers' {
	export const env: Env;
}

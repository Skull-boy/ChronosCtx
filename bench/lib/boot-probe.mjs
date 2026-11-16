// Child process used by swap.mjs to measure cold module-load + listen time.
// Kept separate because in-process import figures are meaningless once a module
// is already in the module cache.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";

const impl = process.argv[2];
const deps = process.env.P0_DEPS;
const requireFromDeps = createRequire(path.join(deps, "index.cjs"));
const t0 = performance.now();

if (impl === "nodeHttp") {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.method === "GET" ? '{"ok":true}' : '{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ms = performance.now() - t0;
  await new Promise((r) => server.close(r));
  process.stdout.write(JSON.stringify({ ms }));
} else {
  const resolved = requireFromDeps.resolve("fastify");
  const { default: Fastify } = await import(pathToFileURL(resolved).href);
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ ok: true }));
  app.post("/mcp", async () => ({ jsonrpc: "2.0", id: 1, result: {} }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const ms = performance.now() - t0;
  await app.close();
  process.stdout.write(JSON.stringify({ ms }));
}

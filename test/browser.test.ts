// The SDK refuses to load in a web page (client-sdks: "An SDK refuses to run
// inside a web page"). A bundler targeting a browser resolves the package under
// the "browser" export condition; Node's --conditions=browser resolves it the
// same way, so these run the package as a browser bundle would see it.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The package root, so "jennah-sdk-ts" resolves by self-reference through the
// published exports map (and so through dist/, which `npm test` builds first).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runModule(script: string, conditions: string[] = []) {
  return spawnSync(
    process.execPath,
    [...conditions.map((c) => `--conditions=${c}`), "--input-type=module", "-e", script],
    { cwd: ROOT, encoding: "utf-8", env: { ...process.env, JENNAH_API_KEY: "" }, timeout: 30_000 },
  );
}

test("loading the SDK in a browser fails with the reason", () => {
  for (const specifier of ["jennah-sdk-ts", "jennah-sdk-ts/gen/jennah/agent/v1/agent_pb"]) {
    const r = runModule(`await import(${JSON.stringify(specifier)}); console.log("LOADED");`, ["browser"]);
    assert.notEqual(r.status, 0, `${specifier} loaded under the browser condition`);
    assert.ok(!r.stdout.includes("LOADED"), `${specifier} loaded under the browser condition`);
    assert.match(r.stderr, /runs only on a server/, `${specifier}: ${r.stderr}`);
  }
});

// Asynchronous, so this process's own fake server keeps answering while the
// child runs: spawnSync would block the event loop and the server could never
// see, let alone count, the child's request.
function runModuleAsync(script: string, conditions: string[]): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...conditions.map((c) => `--conditions=${c}`), "--input-type=module", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, JENNAH_API_KEY: "" },
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout });
    });
  });
}

test("no credential is used before the refusal", async () => {
  // A platform that counts every request it receives.
  let requests = 0;
  const server = http2.createServer((_req, res) => {
    requests++;
    res.stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "16" }, { endStream: true });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await runModuleAsync(
      `const m = await import("jennah-sdk-ts");
       const c = new m.Client({ apiKey: "jennah_sk_from_a_web_page", endpoint: "127.0.0.1:${port}", insecure: true });
       await c.agents.listAgents({}, { timeoutMs: 5000 }).catch(() => {});
       console.log("CALLED");
       c.close();`,
      ["browser"],
    );
    assert.ok(!r.stdout.includes("CALLED"), "a client was constructed and called under the browser condition");
    assert.equal(requests, 0, "the key was presented to the platform");
  } finally {
    server.close();
  }
});

test("server-side use is unaffected", () => {
  const r = runModule(
    `const m = await import("jennah-sdk-ts");
     const c = new m.Client({ apiKey: "jennah_sk_server_side" });
     console.log(String(c.credential), c.endpoint);
     c.close();`,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /api key from explicit configuration jennah-grpc\.alphaus\.cloud:443/);
});

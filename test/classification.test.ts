// Every RPC the generated code publishes is classified for retry exactly once,
// and every generated service is reachable from Client.
//
// The default in safeToReplay is "do not replay", which is safe but silent: a
// new RPC would inherit it without anyone deciding. This is where the decision
// is forced.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, SERVICES } from "../src/client.js";
import { CONDITIONAL_REPLAY, NEVER_REPLAY, REPLAYABLE_READS } from "../src/retry.js";
import { generatedServices, publishedMethods } from "./generated.js";

const SETS = [REPLAYABLE_READS, CONDITIONAL_REPLAY, NEVER_REPLAY];

test("every method is classified exactly once", async () => {
  const methods = await publishedMethods();
  // A floor, so a walk that found nothing fails without every new RPC failing it.
  assert.ok(methods.size >= 67, `walked ${methods.size} methods, expected at least 67`);
  const wrong = [...methods].filter((m) => SETS.filter((s) => s.has(m)).length !== 1);
  assert.deepEqual(wrong, [], "each method must be in exactly one set");
});

test("no classification names a missing method", async () => {
  // A stale entry hides that its RPC was renamed.
  const methods = await publishedMethods();
  const stale = SETS.flatMap((s) => [...s]).filter((m) => !methods.has(m));
  assert.deepEqual(stale, [], "classified but not published");
});

test("every generated service is bound on Client", async () => {
  const bound = new Set(Object.values(SERVICES).map((s) => s.typeName));
  const missing = (await generatedServices()).map((s) => s.typeName).filter((n) => !bound.has(n));
  assert.deepEqual(missing, [], "published but not reachable from Client");
  const client = new Client({ apiKey: "jennah_sk_test" });
  try {
    for (const [prop, service] of Object.entries(SERVICES)) {
      const bound = (client as unknown as Record<string, Record<string, unknown>>)[prop];
      assert.ok(bound, `Client.${prop} is missing`);
      for (const m of service.methods) assert.equal(typeof bound[m.localName], "function", `Client.${prop}.${m.localName}`);
    }
  } finally {
    client.close();
  }
});

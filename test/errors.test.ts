// Reading the platform's status out of an error.

import { Code, ConnectError } from "@connectrpc/connect";
import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "../src/client.js";
import { code, isTransient, isUnauthenticated, SessionExpiredError } from "../src/errors.js";
import { AgentService } from "../src/gen/jennah/agent/v1/agent_pb.js";
import { serve, sleep } from "./helpers.js";

test("code reports every gRPC status", () => {
  for (const c of Object.values(Code).filter((v): v is Code => typeof v === "number")) {
    assert.equal(code(new ConnectError("x", c)), c);
  }
});

test("code follows the cause chain, and carries nothing for a plain error", () => {
  const rejection = new ConnectError("rejected", Code.Unauthenticated);
  const err = new SessionExpiredError("", { cause: rejection });
  assert.equal(code(err), Code.Unauthenticated);
  assert.ok(isUnauthenticated(err));
  assert.ok(!isTransient(err));
  assert.equal(code(new Error("plain")), undefined);
  assert.equal(code(undefined), undefined);
  assert.equal(code("a string"), undefined);
  const loop = new Error("loop") as Error & { cause?: unknown };
  loop.cause = loop;
  assert.equal(code(loop), undefined);
});

test("isTransient is UNAVAILABLE only", () => {
  assert.ok(isTransient(new ConnectError("x", Code.Unavailable)));
  for (const c of [Code.ResourceExhausted, Code.DeadlineExceeded, Code.Aborted, Code.Internal]) {
    assert.ok(!isTransient(new ConnectError("x", c)), Code[c]);
  }
});

test("a caller's abort and deadline read as cancellation, not as unknown", async () => {
  const served = await serve((router) => {
    router.service(AgentService, {
      async listAgents() {
        await sleep(2000);
        return {};
      },
    });
  });
  const c = new Client({ apiKey: "jennah_sk_test", endpoint: served.endpoint, insecure: true });
  try {
    const signal = AbortSignal.timeout(50);
    const aborted = await c.agents.listAgents({}, { signal }).then(() => undefined, (e: unknown) => e);
    assert.ok([Code.Canceled, Code.DeadlineExceeded].includes(code(aborted) as Code), String(aborted));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const canceled = await c.agents.listAgents({}, { signal: ctl.signal }).then(() => undefined, (e: unknown) => e);
    assert.equal(code(canceled), Code.Canceled, String(canceled));
    const late = await c.agents.listAgents({}, { timeoutMs: 50 }).then(() => undefined, (e: unknown) => e);
    assert.equal(code(late), Code.DeadlineExceeded, String(late));
  } finally {
    c.close();
    await served.close();
  }
});

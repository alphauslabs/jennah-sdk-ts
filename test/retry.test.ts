// Transport retry: UNAVAILABLE only, only where a replay cannot produce a
// second effect, bounded by attempts and by the caller's deadline.

import { Code, ConnectError } from "@connectrpc/connect";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { Client, type ClientOptions } from "../src/client.js";
import { code } from "../src/errors.js";
import { AgentService } from "../src/gen/jennah/agent/v1/agent_pb.js";
import { MemoryService } from "../src/gen/jennah/agent/v1/memory_pb.js";
import { ApprovalService } from "../src/gen/jennah/approval/v1/approval_pb.js";
import { DataService } from "../src/gen/jennah/datastore/v1/data_pb.js";
import { serve, type Served } from "./helpers.js";

// Every method answers UNAVAILABLE and counts its attempts.
const attempts = new Map<string, number>();
let served: Served;
function unavailable(name: string) {
  return async (): Promise<never> => {
    attempts.set(name, (attempts.get(name) ?? 0) + 1);
    throw new ConnectError("draining", Code.Unavailable);
  };
}

before(async () => {
  served = await serve((router) => {
    router.service(AgentService, { listAgents: unavailable("listAgents"), createAgent: unavailable("createAgent") });
    router.service(MemoryService, { commitMemory: unavailable("commitMemory"), formMemory: unavailable("formMemory") });
    router.service(DataService, { commitData: unavailable("commitData") });
    router.service(ApprovalService, { createApproval: unavailable("createApproval") });
  });
});
after(() => served.close());
beforeEach(() => attempts.clear());

function client(extra: Partial<ClientOptions> = {}): Client {
  return new Client({ apiKey: "jennah_sk_test", endpoint: served.endpoint, insecure: true, retry: { baseBackoffMs: 1, maxBackoffMs: 2 }, ...extra });
}

async function attemptsOf(name: string, call: () => Promise<unknown>): Promise<number> {
  const err = await call().then(() => undefined, (e: unknown) => e);
  assert.equal(code(err), Code.Unavailable, `${name}: ${String(err)}`);
  return attempts.get(name) ?? 0;
}

test("a read is retried up to the attempt cap", async () => {
  const c = client();
  try {
    assert.equal(await attemptsOf("listAgents", () => c.agents.listAgents({})), 3);
  } finally {
    c.close();
  }
});

test("a create is never retried", async () => {
  const c = client();
  try {
    assert.equal(await attemptsOf("createAgent", () => c.agents.createAgent({})), 1);
  } finally {
    c.close();
  }
});

test("conditional writes are retried only with their replay evidence", async () => {
  const c = client();
  try {
    const cases: [string, () => Promise<unknown>, number][] = [
      ["commitMemory", () => c.memory.commitMemory({ log: {} }), 1],
      ["commitMemory", () => c.memory.commitMemory({ vectors: [] }), 3],
      ["formMemory", () => c.memory.formMemory({}), 1],
      ["formMemory", () => c.memory.formMemory({ formationKey: "k1" }), 3],
      ["commitData", () => c.data.commitData({}), 1],
      ["commitData", () => c.data.commitData({ idempotencyKey: "k1" }), 3],
      ["createApproval", () => c.approvals.createApproval({}), 1],
      ["createApproval", () => c.approvals.createApproval({ requestKey: "k1" }), 3],
    ];
    for (const [name, call, want] of cases) {
      attempts.clear();
      assert.equal(await attemptsOf(name, call), want, `${name} ${call.toString()}`);
    }
  } finally {
    c.close();
  }
});

test("retry can be disabled", async () => {
  const c = client({ retry: { disabled: true } });
  try {
    assert.equal(await attemptsOf("listAgents", () => c.agents.listAgents({})), 1);
  } finally {
    c.close();
  }
});

test("the caller's deadline bounds every attempt together", async () => {
  // A backoff far longer than the deadline: the deadline must end the call.
  const c = client({ retry: { baseBackoffMs: 60_000, maxBackoffMs: 60_000 } });
  try {
    const started = Date.now();
    const err = await c.agents.listAgents({}, { timeoutMs: 300 }).then(() => undefined, (e: unknown) => e);
    assert.ok(Date.now() - started < 5000, "the retry outlived the caller's deadline");
    assert.ok([Code.Unavailable, Code.DeadlineExceeded].includes(code(err) as Code), String(err));
    assert.equal(attempts.get("listAgents"), 1);
  } finally {
    c.close();
  }
});

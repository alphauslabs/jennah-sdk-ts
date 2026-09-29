// Renewal and the static source, beyond what the shared suite covers.

import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as util from "node:util";

import { Client } from "../src/client.js";
import { newSession, Origin, SessionSource, StaticSource } from "../src/credentials.js";
import { code, CredentialRefusedError, SessionExpiredError, SessionPersistError } from "../src/errors.js";
import { AgentService } from "../src/gen/jennah/agent/v1/agent_pb.js";
import { AuthService } from "../src/gen/jennah/auth/v1/auth_pb.js";
import { emptyMachine, serve, sleep, writeSession, type Machine, type Served } from "./helpers.js";

let m: Machine;
beforeEach(() => (m = emptyMachine()));
afterEach(() => m.restore());

interface Platform {
  served: Served;
  refreshCalls: number;
  refreshBearers: string[];
  accept: string;
}

// ListAgents accepts `accept`; RefreshToken is answered by `refresh`.
async function platform(accept: string, refresh: (token: string) => { accessToken: string; refreshToken: string }): Promise<Platform> {
  const p = { refreshCalls: 0, refreshBearers: [] as string[], accept } as Platform;
  const bearer = (ctx: HandlerContext) => (ctx.requestHeader.get("authorization") ?? "").replace(/^Bearer /, "");
  p.served = await serve((router) => {
    router.service(AgentService, {
      async listAgents(_req, ctx) {
        if (bearer(ctx) !== p.accept) throw new ConnectError("rejected", Code.Unauthenticated);
        return {};
      },
    });
    router.service(AuthService, {
      async refreshToken(req, ctx) {
        p.refreshCalls++;
        p.refreshBearers.push(bearer(ctx));
        const r = refresh(req.refreshToken);
        p.accept = r.accessToken;
        return { ...r, expiresIn: 3600n };
      },
    });
  });
  return p;
}

const EXPIRED = { endpoint: "https://jennah.alphaus.cloud", access_token: "at_old", refresh_token: "rt_old", token_type: "Bearer", expires_in: -60 };

test("concurrent rejections produce one renewal", async () => {
  let renewals = 0;
  const source = new SessionSource(newSession({ accessToken: "at_old", refreshToken: "rt_old" }), Origin.Explicit, async () => {
    renewals++;
    await sleep(20);
    return { accessToken: "at_new", refreshToken: "rt_new", expiresAt: 0 };
  });
  const got = await Promise.all(Array.from({ length: 8 }, () => source.renew("at_old")));
  assert.equal(renewals, 1);
  assert.deepEqual(new Set(got), new Set(["at_new"]));
});

test("a rejected refresh token ends the call instead of deadlocking or recursing", async () => {
  writeSession(m.sessionPath, EXPIRED);
  const p = await platform("at_current", () => {
    throw new ConnectError("the refresh token is invalid", Code.Unauthenticated);
  });
  const client = new Client({ endpoint: p.served.endpoint, insecure: true });
  try {
    const started = Date.now();
    const err = await client.agents.listAgents({}).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof SessionExpiredError, util.inspect(err));
    assert.ok(Date.now() - started < 5000, "the renewal waited on itself");
    assert.equal(p.refreshCalls, 1);
    assert.deepEqual(p.refreshBearers, [""], "the renewal carried a bearer");
  } finally {
    client.close();
    await p.served.close();
  }
});

test("a renewal that cannot be written back is surfaced as SessionPersistError", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  writeSession(m.sessionPath, EXPIRED);
  const p = await platform("at_current", () => ({ accessToken: "at_new", refreshToken: "rt_new" }));
  const client = new Client({ endpoint: p.served.endpoint, insecure: true });
  fs.chmodSync(path.dirname(m.sessionPath), 0o500);
  try {
    const err = await client.agents.listAgents({}).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof SessionPersistError, util.inspect(err));
    assert.match((err as Error).message, /could not write it back/);
  } finally {
    client.close();
    await p.served.close();
  }
});

test("a rejected API key is refused without a renewal attempt", async () => {
  const p = await platform("at_current", () => ({ accessToken: "x", refreshToken: "y" }));
  const client = new Client({ credentials: new StaticSource("jennah_sk_revoked"), endpoint: p.served.endpoint, insecure: true });
  try {
    const err = await client.agents.listAgents({}).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof CredentialRefusedError, util.inspect(err));
    assert.equal(code(err), Code.Unauthenticated);
    assert.equal(p.refreshCalls, 0);
  } finally {
    client.close();
    await p.served.close();
  }
});

test("a rejected static access token is not renewed and keeps its status", async () => {
  const p = await platform("at_current", () => ({ accessToken: "x", refreshToken: "y" }));
  const client = new Client({ credentials: new StaticSource("eyJ.user.token"), endpoint: p.served.endpoint, insecure: true });
  try {
    const err = await client.agents.listAgents({}).then(() => undefined, (e: unknown) => e);
    assert.equal(code(err), Code.Unauthenticated, util.inspect(err));
    assert.equal(p.refreshCalls, 0);
  } finally {
    client.close();
    await p.served.close();
  }
});

test("a static source reports its kind and origin and never its secret", () => {
  const client = new Client({ credentials: new StaticSource("eyJ.secret.token") });
  try {
    const info = client.credential;
    assert.equal(String(info), "session from explicit configuration");
    const rendered = [JSON.stringify(info), util.inspect(info, { showHidden: true }), util.inspect(client, { showHidden: true, depth: 5 })].join(" ");
    assert.ok(!rendered.includes("eyJ.secret.token"), "the report leaks the credential");
  } finally {
    client.close();
  }
});

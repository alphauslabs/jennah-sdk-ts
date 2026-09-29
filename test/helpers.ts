// Shared by the tests: an in-process gRPC server, and an empty machine.

import type { ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import * as fs from "node:fs";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { ENV_API_KEY } from "../src/errors.js";

export interface Served {
  endpoint: string;
  close(): Promise<void>;
}

/** Serve `routes` over cleartext HTTP/2 on a free loopback port. */
export async function serve(routes: (router: ConnectRouter) => void): Promise<Served> {
  const server = http2.createServer(connectNodeAdapter({ routes }));
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (s) => {
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // A client's pooled connection would otherwise keep close() waiting.
        for (const s of sessions) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface Machine {
  dir: string;
  sessionPath: string;
  restore(): void;
}

/**
 * An empty machine: a fresh per-user config directory and no API key in the
 * environment, so neither the developer's real session nor their key leaks in.
 */
export function emptyMachine(): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jennah-sdk-ts-"));
  const saved = new Map<string, string | undefined>();
  for (const k of ["XDG_CONFIG_HOME", "HOME", "APPDATA", ENV_API_KEY]) saved.set(k, process.env[k]);
  process.env.XDG_CONFIG_HOME = dir;
  process.env.HOME = dir;
  process.env.APPDATA = dir;
  delete process.env[ENV_API_KEY];
  return {
    dir,
    sessionPath: path.join(dir, "jennah", "credentials"),
    restore() {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const sessionDir = path.join(dir, "jennah");
      if (fs.existsSync(sessionDir)) fs.chmodSync(sessionDir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface SessionSpec {
  raw?: string;
  endpoint?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  /** Seconds relative to now; absent writes expires_at 0 (unknown). */
  expires_in?: number;
}

/**
 * Put a session on disk as another process would: the canonical format
 * written directly, not through the SDK under test.
 */
export function writeSession(file: string, s: SessionSpec): void {
  let data: string;
  if (s.raw !== undefined) {
    data = s.raw;
  } else {
    const expiresAt = s.expires_in !== undefined ? Math.floor(Date.now() / 1000) + s.expires_in : 0;
    data = JSON.stringify(
      {
        endpoint: s.endpoint ?? "",
        access_token: s.access_token ?? "",
        refresh_token: s.refresh_token ?? "",
        token_type: s.token_type ?? "",
        expires_at: expiresAt,
      },
      null,
      2,
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.harness`;
  fs.writeFileSync(tmp, data);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

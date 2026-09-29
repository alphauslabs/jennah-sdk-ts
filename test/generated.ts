// Walks the generated code on disk, so neither a new service nor a new proto
// package can slip past a test that uses it.

import type { DescService } from "@bufbuild/protobuf";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "gen");

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : e.name.endsWith("_pb.js") ? [p] : [];
  });
}

export async function generatedServices(): Promise<DescService[]> {
  const out: DescService[] = [];
  for (const f of files(GEN)) {
    const mod = (await import(pathToFileURL(f).href)) as Record<string, unknown>;
    for (const v of Object.values(mod)) {
      if (v && typeof v === "object" && (v as { kind?: unknown }).kind === "service") out.push(v as DescService);
    }
  }
  return out;
}

export async function publishedMethods(): Promise<Set<string>> {
  const methods = new Set<string>();
  for (const s of await generatedServices()) {
    for (const m of s.methods) methods.add(`/${s.typeName}/${m.name}`);
  }
  return methods;
}

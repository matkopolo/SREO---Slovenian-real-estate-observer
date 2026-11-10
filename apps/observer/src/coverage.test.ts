import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const SRC = join(__dirname);
/** Account and service endpoints are not market data and are outside the observer. */
const OUT_OF_SCOPE = /^\/api\/v1\/(users|auth|health|meta)\b/;

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** GET data endpoints from the generated OpenAPI contract. */
function contractEndpoints() {
  const schema = readFileSync(join(SRC, "generated/api-schema.d.ts"), "utf8");
  const body = schema.slice(schema.indexOf("export interface paths {"), schema.indexOf("export type webhooks"));
  const blocks = body.split(/\n {4}"(?=\/api\/v1)/).slice(1);
  return blocks.map((block) => ({ path: block.slice(0, block.indexOf('"')), get: /\n {8}get: operations\[/.test(block) }))
    .filter((entry) => entry.get && !OUT_OF_SCOPE.test(entry.path)).map((entry) => entry.path).sort();
}

it("uses every data endpoint of the API contract, and nothing outside it", () => {
  const used = new Set(sources(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\bapi\("(\/api\/v1\/[^"]+)"/g)].map((match) => match[1])));
  const contract = contractEndpoints();
  expect(contract.length).toBeGreaterThanOrEqual(40);
  expect(contract.filter((path) => !used.has(path))).toEqual([]);           // nothing missing
  expect([...used].filter((path) => !contract.includes(path))).toEqual([]); // nothing undocumented
});

it("shows every API loader in a view (no endpoint only referenced by the client)", () => {
  const client = readFileSync(join(SRC, "api.ts"), "utf8");
  const loaders = [...client.matchAll(/^export (?:async function|function|const) (load\w+|search\w+)/gm)].map((match) => match[1]);
  const consumers = sources(SRC).filter((file) => !file.endsWith("api.ts")).map((file) => readFileSync(file, "utf8")).join("\n");
  expect(loaders.length).toBeGreaterThan(20);
  expect(loaders.filter((name) => !new RegExp(`\\b${name}\\b`).test(consumers))).toEqual([]);
});

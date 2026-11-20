import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SERVER_DATE, SERVER_VERSION, TOOLS_HASH, buildServer, hashToolDefs, listToolDefs } from "../src/mcp";
import { Store } from "../src/db/store";

describe("tools_hash", () => {
  const defs = [
    { name: "a", description: "first", inputSchema: z.toJSONSchema(z.object({ x: z.string() })) },
    { name: "b", description: "second", inputSchema: z.toJSONSchema(z.object({ y: z.number().optional() })) },
  ];

  it("is 12 hex chars, stable across calls and independent of tool/key order", async () => {
    const h = await hashToolDefs(defs);
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(await hashToolDefs(defs)).toBe(h);
    expect(await hashToolDefs([...defs].reverse())).toBe(h);
    const real = listToolDefs(buildServer(undefined as unknown as Store));
    expect(await hashToolDefs(real)).toBe(TOOLS_HASH);
    expect(SERVER_VERSION).toBe(`${SERVER_DATE}+${TOOLS_HASH}`);
  });

  it("changes when a schema, description or tool name changes", async () => {
    const h = await hashToolDefs(defs);
    const withField = [defs[0]!, { ...defs[1]!, inputSchema: z.toJSONSchema(z.object({ y: z.number().optional(), verified: z.boolean().optional() })) }];
    expect(await hashToolDefs(withField)).not.toBe(h);
    expect(await hashToolDefs([{ ...defs[0]!, description: "changed" }, defs[1]!])).not.toBe(h);
    expect(await hashToolDefs([defs[0]!, { ...defs[1]!, name: "c" }])).not.toBe(h);
  });
});

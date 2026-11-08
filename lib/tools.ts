import type { ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { makePayPalTools, makePayPalToolsFor } from "./paypal.js";
import { READ_ONLY_TOOLS } from "./policy.js";

export interface StepRecord {
  id: string;
  at: string;
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}

const STUB_NOTE = "PayPal sandbox credentials unset";

// Every PayPal call lands here, refused or failed ones too. The seller desk shows this list as the claim timeline.
export async function record(steps: StepRecord[], name: string, input: unknown, call: () => Promise<unknown>): Promise<unknown> {
  const startedAt = performance.now();
  const entry = { id: randomUUID(), at: new Date().toISOString(), tool: name, input };
  const elapsed = (): number => Math.round((performance.now() - startedAt) * 1000) / 1000;
  try {
    const output = await call();
    steps.push({ ...entry, output, durationMs: elapsed() });
    return output;
  } catch (error) {
    steps.push({ ...entry, error: error instanceof Error ? error.message : String(error), durationMs: elapsed() });
    throw error;
  }
}

// The reviewer reads PayPal and never writes to it. Code makes every money call, after gate().
export function reviewerTools(steps: StepRecord[]): ToolSet {
  const live = makePayPalTools();
  const all = live ?? makePayPalToolsFor("unset", "unset");
  const tools: ToolSet = {};

  for (const name of READ_ONLY_TOOLS) {
    const original = all[name];
    const execute = original?.execute;
    if (original === undefined || execute === undefined) throw new Error(`the PayPal toolkit has no ${name}`);
    tools[name] = {
      ...original,
      execute: async (input, options) =>
        record(steps, name, input, async () => (live === null ? { stub: true, note: STUB_NOTE } : execute(input, options))),
    };
  }
  return tools;
}

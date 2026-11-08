import { createHash } from "node:crypto";
import { z } from "zod";
import { decideEvidence } from "./app-review.js";
import type { EvaluationSummary } from "./app-types.js";

export const EMPTY_EVALUATION: EvaluationSummary = {
  cases: 10, liveCompleted: 0, liveStatus: "blocked", recordedChecks: { passed: 0, total: 10 },
  reportDate: null, honestHolds: null, catches: null, falseRefunds: null,
};

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/), label: z.enum(["honest", "adversarial"]),
  evidence: z.enum(["upload", "live"]), amountCents: z.number().int().positive().safe(),
  message: z.string().min(1).max(2000), clear: z.boolean(), generated: z.boolean(),
  expectedPolicy: z.enum(["approved", "held", "awaiting_live"]),
}).strict();
const manifestSchema = z.object({
  version: z.literal(1), description: z.string().min(20), cases: z.array(caseSchema).length(10),
}).strict().superRefine((value, context) => {
  if (new Set(value.cases.map((row) => row.id)).size !== 10 || value.cases.filter((row) => row.label === "honest").length !== 5) {
    context.addIssue({ code: "custom", message: "Ten unique cases, five honest and five adversarial, are required." });
  }
});
export type EvaluationManifest = z.infer<typeof manifestSchema>;
export const validateManifest = (value: unknown): EvaluationManifest => manifestSchema.parse(value);
export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function assertFrozen(original: string, current: string): void {
  if (original !== current) throw new Error("Frozen evaluation inputs changed. Use a new run identifier.");
}
export interface EvaluationRow {
  id: string; label: "honest" | "adversarial"; decision: "approved" | "held" | "awaiting_live";
  mode: "recorded" | "live"; at: string; modelIds: string[]; durationMs: number;
  hashes: string[]; error?: string; expectedPolicy?: string;
}
export function summarizeEvaluation(manifest: EvaluationManifest, rows: EvaluationRow[], mode: "recorded" | "live", at: string) {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Duplicate evaluation results.");
  for (const row of rows) {
    const expected = manifest.cases.find((value) => value.id === row.id);
    if (!expected || expected.label !== row.label || row.mode !== mode) throw new Error("Evaluation result does not match its frozen case.");
    if (mode === "live" && !row.error && (!row.hashes.length || row.modelIds.length < 2)) throw new Error("Live results require originals and actual model identities.");
  }
  const observed = rows.filter((row) => !row.error), honest = observed.filter((row) => row.label === "honest"), adversarial = observed.filter((row) => row.label === "adversarial");
  const rate = (count: number, total: number) => ({ count, total, rate: total ? count / total : null });
  return {
    mode, at, manifestHash: fingerprint(manifest), cases: 10, completed: observed.length,
    status: observed.length === 10 ? "complete" as const : observed.length ? "incomplete" as const : "blocked" as const,
    notice: mode === "recorded" ? "Scripted policy inputs only. These are not measured photo-review or physical-camera results." : "Ten-case demo measurement, not a production accuracy guarantee. Policy eligibility is controlled for this evaluation; no money is moved.",
    policyChecks: { passed: mode === "recorded" ? observed.filter((row) => row.decision === row.expectedPolicy).length : 0, total: mode === "recorded" ? 10 : 0 },
    honestHolds: rate(honest.filter((row) => row.decision !== "approved").length, honest.length),
    catches: rate(adversarial.filter((row) => row.decision !== "approved").length, adversarial.length),
    falseRefunds: rate(adversarial.filter((row) => row.decision === "approved").length, adversarial.length),
    errors: rows.filter((row) => row.error).length,
    modelIds: [...new Set(rows.flatMap((row) => row.modelIds))],
    rows,
  };
}
export function runRecordedEvaluation(manifest: EvaluationManifest, at = new Date().toISOString()) {
  const rows: EvaluationRow[] = manifest.cases.map((row) => {
    const decision = decideEvidence({
      amountCents: row.amountCents, evidence: row.evidence, message: row.message,
      credentials: [{ status: row.generated ? "present" : "missing", generated: row.generated }],
      clear: row.clear, listingBound: true, eligible: true, payerRefunds90d: 0, judge: false,
    });
    return { id: row.id, label: row.label, decision: decision.status, mode: "recorded",
      at, modelIds: [], durationMs: 0, hashes: [], expectedPolicy: row.expectedPolicy };
  });
  return summarizeEvaluation(manifest, rows, "recorded", at);
}

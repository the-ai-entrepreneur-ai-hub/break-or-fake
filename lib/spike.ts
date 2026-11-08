import { z } from "zod";
import type { Credentials } from "./provenance.js";

const signal = z.enum(["yes", "no", "uncertain"]);
export const findingsSchema = z.object({
  frames: z.preprocess(value => Array.isArray(value) && value.length > 3 ? undefined : value, z.array(z.object({
    frame: z.number().int().min(1).max(3),
    codeRead: z.string().nullable(),
    handwritten: signal,
    physicalScene: signal,
    sameItem: signal,
    plausibleDamage: signal,
    otherText: z.preprocess(value => Array.isArray(value) && value.some(item => typeof item !== "string") ? undefined : value, z.array(z.string())),
    reason: z.string().min(1),
  }).strict()).length(3).refine((frames) => new Set(frames.map((frame) => frame.frame)).size === 3, "duplicate frame findings")),
  tiltConsistent: signal,
}).strict();
export type SpikeFindings = z.infer<typeof findingsSchema>;

export const instructionLike = (text: string) =>
  /ignore\b.{0,80}\b(instruction|previous|above)|\b(system|assistant|developer)\s*:|\b(approve|refund|pay)\b.{0,40}\b(claim|immediately|now)|\b(do not|don't)\s+(review|check)|\b(instructions?|system prompt|tool call)\b/i.test(text);

export function decideSpike(input: SpikeFindings, code: string, credentials: Credentials[], message: string) {
  const findings = findingsSchema.parse(input);
  const codeRead = findings.frames.every((frame) => frame.codeRead === code);
  const wouldRefund = codeRead && findings.tiltConsistent === "yes" &&
    findings.frames.every((frame) => frame.handwritten === "yes" && frame.physicalScene === "yes" &&
      frame.sameItem === "yes" && frame.plausibleDamage === "yes" && !frame.otherText.some(instructionLike)) &&
    credentials.length > 0 && credentials.every((value) => !value.generated && ["missing", "present"].includes(value.status)) &&
    !instructionLike(message);
  return { codeRead, wouldRefund };
}

export const trialResultSchema = z.object({
  id: z.string().min(1),
  group: z.enum(["honest", "replay"]),
  device: z.enum(["iphone", "android"]),
  mode: z.enum(["live", "recorded"]),
  model: z.string().min(1),
  at: z.string().datetime(),
  codeRead: z.boolean(),
  wouldRefund: z.boolean(),
  error: z.string().optional(),
}).passthrough();
export type TrialResult = z.infer<typeof trialResultSchema>;

export function summarizeSpike(input: TrialResult[]) {
  const trials = input.map((trial) => trialResultSchema.parse(trial));
  if (new Set(trials.map((trial) => trial.id)).size !== trials.length) throw new Error("duplicate trial ids");
  const live = trials.filter((trial) => trial.mode === "live" && !trial.error);
  const honest = live.filter((trial) => trial.group === "honest");
  const replays = live.filter((trial) => trial.group === "replay");
  const codesRead = honest.filter((trial) => trial.codeRead).length;
  const paid = replays.filter((trial) => trial.wouldRefund).length;
  const complete = honest.length === 20 && replays.length === 20 &&
    new Set(honest.map((trial) => trial.device)).size === 2 &&
    new Set(live.map((trial) => trial.model)).size === 1 && !trials.some((trial) => trial.mode === "live" && trial.error);
  return {
    decision: !complete ? "blocked" : codesRead >= 18 && paid === 0 ? "go" : "no-go",
    honest: { completed: honest.length, target: 20, codesRead, codeReadRate: honest.length ? codesRead / honest.length : null,
      held: honest.filter((trial) => !trial.wouldRefund).length, holdRate: honest.length ? honest.filter((trial) => !trial.wouldRefund).length / honest.length : null },
    replay: { completed: replays.length, target: 20, wouldRefund: paid, catchRate: replays.length ? (replays.length - paid) / replays.length : null },
    recorded: trials.filter((trial) => trial.mode === "recorded").length,
    errors: trials.filter((trial) => trial.error).length,
    moneyCalls: 0,
  };
}

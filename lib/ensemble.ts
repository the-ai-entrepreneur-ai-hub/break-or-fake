import { findingsSchema, type SpikeFindings } from "./spike.js";
import { reviewImages, type VisionRequest } from "./vision.js";

// A refund needs at least this many reviewers to answer, and every answer must agree.
export const MIN_REVIEWS = 2;
type Signal = SpikeFindings["tiltConsistent"];
type Frame = SpikeFindings["frames"][number];

// Unanimous "yes" is the only "yes". One "no" is a "no". Anything else stays uncertain, which never refunds.
const agree = (values: Signal[]): Signal => values.every((value) => value === "yes") ? "yes" : values.some((value) => value === "no") ? "no" : "uncertain";

export function mergeFindings(all: SpikeFindings[]): SpikeFindings {
  const reviews = all.map((findings) => findingsSchema.parse(findings));
  if (reviews.length < MIN_REVIEWS) throw new Error(`at least ${MIN_REVIEWS} reviews are needed to decide`);
  const frames = [1, 2, 3].map((frame) => {
    const rows = reviews.map((review) => review.frames.find((value) => value.frame === frame) as Frame);
    const codes = new Set(rows.map((row) => row.codeRead));
    return {
      frame,
      // Reviewers that read different codes cancel each other out: no code, so no refund.
      codeRead: codes.size === 1 ? rows[0].codeRead : null,
      handwritten: agree(rows.map((row) => row.handwritten)),
      physicalScene: agree(rows.map((row) => row.physicalScene)),
      sameItem: agree(rows.map((row) => row.sameItem)),
      plausibleDamage: agree(rows.map((row) => row.plausibleDamage)),
      otherText: [...new Set(rows.flatMap((row) => row.otherText))],
      reason: rows.map((row) => row.reason).join(" | "),
    };
  });
  return findingsSchema.parse({ frames, tiltConsistent: agree(reviews.map((review) => review.tiltConsistent)) });
}

export interface ReviewerRun { model: string; ok: boolean; returnedModel?: string; durationMs: number; error?: string }
export interface EnsembleReview { findings: SpikeFindings; reviews: ReviewerRun[] }

// Runs every model at once through OpenRouter and merges the answers. A reviewer that fails or returns
// something other than the findings JSON is recorded and left out; the merge then needs the rest to agree.
export async function reviewWithEnsemble(
  models: string[], key: string, request: VisionRequest, review: typeof reviewImages = reviewImages,
): Promise<EnsembleReview> {
  if (models.length < MIN_REVIEWS) throw new Error(`at least ${MIN_REVIEWS} reviewer models are needed`);
  const runs = await Promise.allSettled(models.map(async (model) => {
    const started = performance.now();
    const reply = await review("openrouter", model, key, request);
    return { model, reply, durationMs: performance.now() - started };
  }));
  const reviews: ReviewerRun[] = [];
  const answers: SpikeFindings[] = [];
  runs.forEach((run, index) => {
    if (run.status === "rejected") {
      reviews.push({ model: models[index], ok: false, durationMs: 0, error: run.reason instanceof Error ? run.reason.message : "review failed" });
      return;
    }
    const { model, reply, durationMs } = run.value;
    try {
      answers.push(findingsSchema.parse(JSON.parse(reply.raw)));
      reviews.push({ model, ok: true, returnedModel: reply.model, durationMs });
    } catch {
      reviews.push({ model, ok: false, returnedModel: reply.model, durationMs, error: "review was not the findings JSON" });
    }
  });
  return { findings: mergeFindings(answers), reviews };
}

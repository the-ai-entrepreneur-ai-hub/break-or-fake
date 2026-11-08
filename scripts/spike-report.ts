import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizeSpike, trialResultSchema } from "../lib/spike.js";

const root = new URL("../.notes/", import.meta.url).pathname;
const directory = resolve(root, "spike-results");
await mkdir(directory, { recursive: true });
const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
const trials = await Promise.all(files.map(async (name) => trialResultSchema.parse(JSON.parse(await readFile(resolve(directory, name), "utf8")))));
const summary = { asOf: new Date().toISOString(), ...summarizeSpike(trials) };
await writeFile(resolve(root, "OCT19.json"), `${JSON.stringify(summary, null, 2)}\n`);
const text = `# Oct 19 decision gate

Recorded at ${summary.asOf}. This is the current evidence state, not a claim that the calendar has reached Oct 19.

Decision: ${summary.decision}.

| Measurement | Observed | Required |
| --- | --- | --- |
| Completed honest live trials | ${summary.honest.completed} | 20 across both phones |
| Honest codes read | ${summary.honest.codesRead} / ${summary.honest.completed} | at least 18 / 20 |
| Honest holds | ${summary.honest.held} / ${summary.honest.completed} | publish alongside catch rate |
| Completed replay live trials | ${summary.replay.completed} | 20 |
| Replays that would refund | ${summary.replay.wouldRefund} / ${summary.replay.completed} | 0 / 20 |
| Recorded-only trials excluded | ${summary.recorded} | not live measurements |
| Failed trials | ${summary.errors} | resolve before a go decision |
| Money calls made by spike | 0 | 0 |

${summary.decision === "blocked" ? "The measured dataset is incomplete. Rates with no observations are null in OCT19.json. This is not an empirical failure or a pass. Do not move to the Oct 20 work." : summary.decision === "no-go" ? "The measured threshold failed. The next permitted product path is the upload-and-seller-review fallback, after this stop." : "The measured threshold passed. Stop here as requested before the Oct 20 work."}
`;
await writeFile(resolve(root, "OCT19.md"), text);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.decision === "blocked" ? 77 : summary.decision === "no-go" ? 1 : 0;

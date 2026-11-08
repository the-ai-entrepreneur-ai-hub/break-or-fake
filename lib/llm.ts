import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages";
import { zodSchema, type ToolSet } from "ai";
import type { ZodTypeAny } from "zod";
import { READ_ONLY_TOOLS } from "./policy.js";

export const DEFAULT_MODEL = `claude-opus-5-5`;
// The model always thinks before it answers, and the thinking counts toward this cap.
export const MAX_TOKENS = 16000;
export const MAX_STEPS = 6;

export type CreateMessage = (params: MessageCreateParamsNonStreaming) => Promise<BetaMessage>;

export function makeClient(): CreateMessage {
  const client = new Anthropic();
  return (params) => client.beta.messages.create(params);
}

export interface ReviewRequest {
  createMessage: CreateMessage;
  system: string;
  task: string;
  tools: ToolSet;
  images?: { mediaType: "image/jpeg" | "image/png"; data: string }[];
}

// Every tool here comes from the PayPal toolkit, which builds each one on a zod object.
const schemaOf = (tool: ToolSet[string]): ZodTypeAny => tool.parameters as ZodTypeAny;

function definitions(tools: ToolSet): BetaTool[] {
  if (Object.keys(tools).some((name) => !READ_ONLY_TOOLS.has(name))) throw new Error("only read-only reviewer tools may reach the model");
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? "",
    input_schema: zodSchema(schemaOf(tool)).jsonSchema as BetaTool.InputSchema,
  }));
}

async function runTool(tools: ToolSet, call: BetaToolUseBlock): Promise<BetaToolResultBlockParam> {
  const tool = tools[call.name];
  const refuse = (content: string): BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: call.id, content, is_error: true });
  if (tool?.execute === undefined) return refuse(`There is no tool named ${call.name}.`);

  // A mis-shaped call goes back as an error result and the model fixes it on its next step. The
  // reviewer has only read tools, so nothing here moves money.
  const parsed = schemaOf(tool).safeParse(call.input);
  if (!parsed.success) return refuse(`Invalid arguments, fix them and call the tool again: ${parsed.error.message}`);

  // An error from execute ends the run.
  const output: unknown = await tool.execute(parsed.data, { toolCallId: call.id, messages: [] });
  // The PayPal tools already return JSON text; encoding it again would hand the model an escaped string.
  return { type: "tool_result", tool_use_id: call.id, content: typeof output === "string" ? output : JSON.stringify(output ?? null) };
}

function stopLabel(message: BetaMessage): string {
  if (message.stop_reason !== "refusal") return String(message.stop_reason);
  return `refusal (${message.stop_details?.category ?? "no category"})`;
}

export async function runText({ createMessage, system, task, tools, images = [] }: ReviewRequest): Promise<string> {
  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  const toolDefinitions = definitions(tools);
  const messages: BetaMessageParam[] = [{
    role: "user",
    content: images.length ? [
      { type: "text", text: task },
      ...images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType, data: image.data } })),
    ] : task,
  }];

  for (let step = 1; ; step++) {
    const response = await createMessage({
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools: toolDefinitions,
      messages,
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      // A policy decline is retried server side on the recommended fallback model instead of ending the run.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    // Append the reply unchanged: its thinking blocks stay valid only in an append-only history.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      if (text.trim() === "") throw new Error("the model ended without a final answer");
      return text;
    }
    if (response.stop_reason !== "tool_use") throw new Error(`the model stopped with ${stopLabel(response)} before a final answer`);
    // The last step runs no tools, so nothing moves without a final answer to report it.
    if (step === MAX_STEPS) throw new Error(`no final answer after ${MAX_STEPS} model calls`);

    const results: BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") results.push(await runTool(tools, block));
    }
    messages.push({ role: "user", content: results });
  }
}

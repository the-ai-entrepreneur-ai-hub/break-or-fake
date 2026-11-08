import { ALL_TOOLS_ENABLED, PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { Client, Environment } from "@paypal/paypal-server-sdk";
import type { Tool } from "ai";
import { z } from "zod";

// Orders for reviewer lookups, disputes for escalations. No invoices or subscriptions.
const ENABLED_PRODUCTS = ["orders", "disputes"] as const;

function actionsFor(products: readonly string[]): Record<string, Record<string, boolean>> {
  const actions: Record<string, Record<string, boolean>> = {};
  for (const product of products) {
    const productActions = ALL_TOOLS_ENABLED[product];
    if (productActions === undefined) throw new Error(`@paypal/agent-toolkit has no product named ${product}`);
    actions[product] = productActions;
  }
  return actions;
}

export function makePayPalToolsFor(clientId: string, clientSecret: string): Record<string, Tool> {
  const toolkit = new PayPalAgentToolkit({
    clientId,
    clientSecret,
    // Hard sandbox on purpose: Break or Fake never talks to a real PayPal environment.
    configuration: { actions: actionsFor(ENABLED_PRODUCTS), context: { sandbox: true } },
  });
  return toolkit.getTools();
}

export function makePayPalTools(): Record<string, Tool> | null {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return makePayPalToolsFor(clientId, clientSecret);
}

// Orders v2 and Payments v2 go through the server SDK: the toolkit's create_order can't set custom_id, and refunds
// are not in the enabled toolkit products.
export function makePayPalClient(): Client | null {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return new Client({
    clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: clientSecret },
    environment: Environment.Sandbox,
    timeout: 30_000,
  });
}

export function makePayPalRest() {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const host = "https://api-m.sandbox.paypal.com";
  let token: string | undefined;
  const errorFor = async (response: Response, operation: string, requestBody?: string): Promise<Error> => {
    const text = z.string().optional();
    const parsed = z.object({
      name: text, message: text, debug_id: text, error: text, error_description: text,
      details: z.array(z.object({ issue: z.string(), field: text, description: text })).optional(),
    }).safeParse(await response.json().catch(() => undefined));
    const data = parsed.success ? parsed.data : undefined;
    const details = data ? [...new Set([
      data.name, data.message,
      ...(data.details ?? []).flatMap(({ issue, field, description }) => [field ? `${issue} (${field})` : issue, description]),
      data.debug_id && `debug_id=${data.debug_id}`, data.error, data.error_description,
    ].filter(Boolean))].join("; ") : "";
    let message = `PayPal ${operation} answered ${response.status}${details ? `: ${details}` : ""}`;
    const secrets = [token, clientSecret, Buffer.from(`${clientId}:${clientSecret}`).toString("base64"), requestBody]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
    return new Error(message);
  };
  return async (path: `/v1/customer/disputes${string}`, body?: Record<string, unknown>, requestId?: string): Promise<unknown> => {
    if (token === undefined) {
      const response = await fetch(`${host}/v1/oauth2/token`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
      if (!response.ok) throw await errorFor(response, "token request", "grant_type=client_credentials");
      token = z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
    }
    const response = await fetch(`${host}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await errorFor(response, path, body === undefined ? undefined : JSON.stringify(body));
    return response.json();
  };
}

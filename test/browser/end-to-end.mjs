import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { computedAudit } from "./acceptance.mjs";

export default async function endToEnd(browser, { baseURL, outputDirectory }) {
  const assertions = [], views = [];
  const verify = (condition, name) => { assertions.push({ name, pass: !!condition }); assert.ok(condition, name); };
  const image = async color => ({
    name: "synthetic-test-image.png", mimeType: "image/png",
    buffer: await sharp({ create: { width: 180, height: 180, channels: 3, background: color } }).png().toBuffer(),
  });
  const original = await image("#dddddd"), damage = await image("#bbaa99");
  const state = () => fetch(baseURL + "/__qa/state").then(response => response.json());
  async function measure(page, name, width) {
    await page.evaluate(async () => { await document.fonts.ready; });
    const result = { name, width, ...await page.evaluate(computedAudit) };
    views.push(result);
    verify(!result.overflow && result.failures.length === 0, `${name} styles at ${width}`);
  }
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    for (const flow of ["camera", "live", "upload", "seller"]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      try {
        await context.route("**/api/config", async route => {
          const response = await route.fetch();
          const config = await response.json();
          await route.fulfill({ response, json: { ...config, paypalClientId: "isolated-test-client" } });
        });
        await context.addInitScript(cameraLabel => {
          window.paypal = {
            Buttons(options) {
              let button;
              return {
                async render(target) {
                  button = document.createElement("button");
                  button.type = "button"; button.className = "button primary";
                  button.textContent = "Approve isolated test checkout";
                  button.onclick = async () => {
                    button.disabled = true;
                    try { await options.onApprove({ orderID: await options.createOrder() }); }
                    catch (error) { options.onError(error); }
                  };
                  target.append(button);
                },
                async close() { button?.remove(); },
              };
            },
          };
          const canvas = document.createElement("canvas");
          canvas.width = 640; canvas.height = 480;
          const draw = canvas.getContext("2d");
          window.__qaCameraFrame = 0;
          const paint = () => {
            const frame = ++window.__qaCameraFrame;
            draw.fillStyle = `rgb(${frame * 37 % 255}, 90, 120)`;
            draw.fillRect(0, 0, 640, 480);
            draw.fillStyle = "#ffffff"; draw.font = "24px sans-serif";
            draw.fillText(`Synthetic camera ${frame}`, 30, 80);
          };
          paint(); setInterval(paint, 80);
          Object.defineProperty(navigator, "mediaDevices", {
            configurable: true, value: { getUserMedia: async () => {
              const stream = canvas.captureStream(10);
              Object.defineProperty(stream.getVideoTracks()[0], "label", { value: cameraLabel });
              return stream;
            } },
          });
        }, flow === "camera" ? "OBS Virtual Camera" : "Back Camera");
        const before = await state();
        await page.goto(baseURL + "/shop");
        await page.locator(".loading-state").waitFor({ state: "hidden" });
        if (flow === "upload") await page.locator(".product-card").first().click();
        else await page.locator(".judge-upload input[type=file]").setInputFiles(original);
        if (flow !== "upload") {
          const guidance = page.getByText("Judges: pay with PayPal's test card 4005 5192 0000 0004, any future date, CVV 123. Choose United States and pay as a guest, without creating an account.", { exact: true });
          await guidance.waitFor();
          const buttons = await page.locator(".paypal-button-mount").boundingBox();
          const hint = await guidance.boundingBox();
          verify(buttons && hint && hint.y >= buttons.y + buttons.height, `Judge test card guidance is below PayPal buttons at ${width}`);
        }
        await page.getByRole("button", { name: "Approve isolated test checkout", exact: true }).click();
        await page.getByRole("heading", { name: "Payment confirmed.", exact: true }).waitFor();
        verify((await state()).captureCalls === before.captureCalls + 1, `${flow} confirms one capture at ${width}`);
        await measure(page, `${flow}-purchase-confirmed`, width);
        await page.getByRole("link", { name: "Start or resume a claim", exact: true }).click();
        await page.getByLabel("What happened to your item?", { exact: true }).fill(`Isolated ${flow} ${width} check: the item arrived torn.`);
        if (flow === "live" || flow === "camera") await page.getByRole("button", { name: "Live photos Three angles, one code", exact: true }).click();
        if (flow === "upload") await page.locator(".claim-form input[type=file]").setInputFiles(damage);
        if (flow === "seller") await page.getByRole("button", { name: "Ask for seller help", exact: true }).click();
        else await page.getByRole("button", { name: "Submit claim", exact: true }).click();
        if (flow === "live" || flow === "camera") {
          await page.waitForURL("**/capture?**");
          await page.getByRole("button", { name: "Start camera and session", exact: true }).click();
          await page.locator("#challenge").waitFor({ state: "visible" });
          verify(/^\d{3}$/.test(await page.locator("#code").innerText()), `Live challenge has three digits at ${width}`);
          await measure(page, "live-capture-before-frames", width);
          for (let frame = 1; frame <= 3; frame++) {
            const next = await page.evaluate(() => window.__qaCameraFrame + 2);
            await page.waitForFunction(target => window.__qaCameraFrame >= target, next);
            await page.getByRole("button", { name: `Take frame ${frame} of 3`, exact: true }).click();
          }
          await page.getByText("Your photos are saved. Return to your claim to see the review result.", { exact: true }).waitFor();
          verify(await page.locator("#previews img").count() === 3, `Three distinct captured frames submitted at ${width}`);
          verify(await page.locator("#camera").evaluate(video => video.srcObject === null), `Successful capture stops camera at ${width}`);
          await measure(page, "live-capture-saved", width);
          await page.getByRole("link", { name: "Back to your claim", exact: true }).click();
        }
        if (flow === "camera") {
          await page.getByRole("heading", { name: /^(Held for the seller\.|Refunded\.)$/ }).waitFor();
          const after = await state();
          verify(await page.getByRole("heading", { name: "Held for the seller.", exact: true }).count() === 1 &&
            await page.locator(".result-reason p").innerText() === "The camera source needs seller review." &&
            after.refundCalls === before.refundCalls && after.refundOperations === before.refundOperations,
          `OBS virtual camera ends held with no refund call at ${width}`);
          await measure(page, "camera-held", width);
          continue;
        }
        if (flow === "seller") {
          await page.getByRole("heading", { name: "Held for the seller.", exact: true }).waitFor();
          const claimId = new URL(page.url()).pathname.split("/").at(-1);
          verify(/^[a-f0-9-]{36}$/.test(claimId), `Seller-help claim has its own private route at ${width}`);
          verify((await state()).refundOperations === before.refundOperations, `Seller help does not auto-refund at ${width}`);
          await page.goto(baseURL + "/seller");
          await page.getByLabel("Password", { exact: true }).fill("viewer-password-for-tests");
          await page.getByRole("button", { name: "Open the queue", exact: true }).click();
          await page.locator(".claim-queue li").filter({ hasText: `Isolated seller ${width} check:` }).locator("button").click();
          await page.locator(".comparison-panel").waitFor();
          verify(await page.locator("#refund-amount").count() === 0, `New held claim has no viewer form at ${width}`);
          const forbidden = await page.request.post(`${baseURL}/api/seller/claims/${claimId}/refund`, {
            headers: { origin: baseURL }, data: { amountCents: 2500 },
          });
          verify(forbidden.status() === 403, `New held claim rejects viewer POST at ${width}`);
          verify((await state()).refundCalls === before.refundCalls, `Viewer denial makes zero refund calls at ${width}`);
          await page.getByRole("button", { name: "Sign out", exact: true }).click();
          await page.getByLabel("Password", { exact: true }).fill("seller-password-for-tests");
          await page.getByRole("button", { name: "Open the queue", exact: true }).click();
          await page.locator(".claim-queue li").filter({ hasText: `Isolated seller ${width} check:` }).locator("button").click();
          await page.getByRole("button", { name: "Review sandbox refund", exact: true }).click();
          await page.getByRole("dialog").waitFor();
          verify((await state()).refundCalls === before.refundCalls, `Confirmation dialog does not send a refund at ${width}`);
          await measure(page, "seller-real-confirmation", width);
          await page.getByRole("button", { name: "Confirm $25.00 sandbox refund", exact: true }).click();
          await page.locator(".refund-confirmed").waitFor();
          const duplicate = await page.request.post(`${baseURL}/api/seller/claims/${claimId}/refund`, {
            headers: { origin: baseURL }, data: { amountCents: 2500 },
          });
          verify(duplicate.ok(), `Repeated completed refund returns existing result at ${width}`);
          await page.goto(`${baseURL}/claim/${claimId}`);
        }
        await page.getByRole("heading", { name: "Refunded.", exact: true }).waitFor();
        verify((await state()).refundOperations === before.refundOperations + 1, `${flow} creates exactly one refund operation at ${width}`);
        verify((await state()).refundCalls === before.refundCalls + 1, `${flow} sends exactly one refund call at ${width}`);
        await measure(page, `${flow}-refunded`, width);
        await page.reload();
        await page.getByRole("heading", { name: "Refunded.", exact: true }).waitFor();
        verify((await state()).refundCalls === before.refundCalls + 1, `${flow} reload preserves refund without another write at ${width}`);
        await measure(page, `${flow}-refunded-after-reload`, width);
      } catch (error) {
        await writeFile(resolve(outputDirectory, "end-to-end-failure.json"), JSON.stringify({ flow, width, error: String(error), assertions, views }, null, 2));
        throw error;
      } finally {
        await page.screenshot({ path: resolve(outputDirectory, `end-to-end-${flow}-${width}.png`), fullPage: true }).catch(() => {});
        await context.close();
      }
    }
  }
  const limitContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await limitContext.newPage();
    const post = async (path, body, token) => {
      const response = await page.request.post(baseURL + path, {
        headers: { origin: baseURL, ...(token ? { authorization: `Bearer ${token}` } : {}) }, data: body,
      });
      assert.ok(response.ok(), `Repeat-buyer request ${path}: ${response.status()}`);
      return response.status() === 204 ? null : response.json();
    };
    await post("/__qa/payer", { id: "qa-repeat-buyer" });
    const before = await state();
    for (let index = 0; index < 3; index++) {
      const order = await post("/api/orders", { productId: "linen" });
      await post(`/api/orders/${order.order.id}/capture`, {}, order.token);
      const { claim } = await post(`/api/orders/${order.order.id}/claims`, {
        message: "Isolated repeat-buyer check: the linen arrived torn.",
        image: { mimeType: damage.mimeType, data: damage.buffer.toString("base64") },
      }, order.token);
      await page.goto(`${baseURL}/claim/${claim.id}#token=${order.token}`);
      await page.getByRole("heading", { name: index < 2 ? "Refunded." : "Held for the seller.", exact: true }).waitFor();
      if (index === 2) {
        verify(await page.locator(".result-reason p").innerText() === "The buyer's recent policy-refund limit requires seller review.", "Third policy refund is held by the real payer-history gate");
        await measure(page, "repeat-buyer-limit-held", 390);
      }
    }
    verify((await state()).refundOperations === before.refundOperations + 2, "Three same-payer claims create only two policy refund operations");
    verify((await state()).refundCalls === before.refundCalls + 2, "Third same-payer claim sends no refund call");
    await post("/__qa/payer", { id: null });
  } finally { await limitContext.close(); }
  const result = {
    syntheticAdapters: true, externalPayments: 0, assertions, views,
    minFont: Math.min(...views.map(view => view.minFont)),
    minContrast: Math.min(...views.map(view => view.minContrast)),
  };
  await writeFile(resolve(outputDirectory, "end-to-end-results.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("sandbox commands exit 77 without credentials and never request approval", () => {
  for (const args of [[], ["--no-refund"], ["dispute"], ["dispute", "case-test"], ["offer", "case-test"], ["ack-return", "case-test"], ["accept", "case-test"]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/sandbox.ts", ...args], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "" },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 77, result.stderr);
    assert.match(result.stdout, /no PayPal call was made/);
    assert.doesNotMatch(result.stdout, /Approve it in a browser/);
  }
});

for (const hasTracker of [true, false]) {
  test(`sandbox ${hasTracker ? "logs Orders v2 tracking" : "fails clearly when the order has no tracker"} without network calls`, () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-tracking-"));
    try {
      mkdirSync(join(root, "scripts"));
      copyFileSync(new URL("../scripts/sandbox.ts", import.meta.url), join(root, "scripts/sandbox.ts"));
      copyFileSync(new URL("../package.json", import.meta.url), join(root, "package.json"));
      for (const directory of ["lib", "node_modules"]) symlinkSync(new URL(`../${directory}`, import.meta.url), join(root, directory), "dir");
      writeFileSync(join(root, "listing.jpg"), "test listing image");
      const script = `
        import assert from "node:assert/strict";
        import { Socket } from "node:net";
        import { OrdersController } from "@paypal/paypal-server-sdk";
        Socket.prototype.connect = () => { throw new Error("network forbidden"); };
        globalThis.fetch = async () => { throw new Error("network forbidden"); };
        OrdersController.prototype.createOrder = async () => ({ result: { id: "order-test", status: "APPROVED" } });
        OrdersController.prototype.captureOrder = async () => ({ result: { purchaseUnits: [{ payments: { captures: [{ id: "capture-test", amount: { currencyCode: "USD", value: "32.00" } }] } }] } });
        OrdersController.prototype.createOrderTracking = async (input) => {
          assert.deepEqual(input, { id: "order-test", body: { captureId: "capture-test", trackingNumber: "9400111899223197428490", carrier: "USPS", notifyPayer: false } });
          return { result: {
            payer: { name: { givenName: "Test", surname: "Buyer" }, emailAddress: "buyer@example.test" },
            purchaseUnits: [{ shipping: { name: { fullName: "Test Buyer" }, address: { addressLine1: "123 Test Street" }, trackers: ${hasTracker ? '[{ id: "tracker-test", status: "SHIPPED" }]' : "[]"} } }],
          } };
        };
        OrdersController.prototype.getOrder = async () => { assert.fail("getOrder must not be called after tracking is posted"); };
        process.argv = [process.execPath, "scripts/sandbox.ts", "--no-refund"];
        await import("./scripts/sandbox.ts");
      `;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: root, encoding: "utf8", timeout: 15000,
        env: { ...process.env, PAYPAL_CLIENT_ID: "test-only", PAYPAL_CLIENT_SECRET: "test-only", LISTING_IMAGE_PATH: join(root, "listing.jpg") },
      });
      assert.equal(result.status, hasTracker ? 0 : 1, result.stderr);
      const log = readFileSync(join(root, "sandbox-ids.jsonl"), "utf8");
      assert.doesNotMatch(log, /Test Buyer|buyer@example\.test|123 Test Street/);
      assert.doesNotMatch(result.stdout, /Test Buyer|buyer@example\.test|123 Test Street/);
      if (hasTracker) {
        const entries = log.trim().split("\n").map((line) => JSON.parse(line));
        const tracking = entries.filter((entry) => entry.step.startsWith("tracking "));
        assert.equal(tracking.length, 1);
        assert.deepEqual(tracking[0], {
          at: tracking[0].at, step: "tracking posted", capture_id: "capture-test", tracking_number: "9400111899223197428490", tracker_id: "tracker-test", status: "SHIPPED",
        });
        assert.match(result.stdout, /tracking posted\s+capture_id=capture-test\s+tracking_number=9400111899223197428490\s+tracker_id=tracker-test\s+status=SHIPPED/);
      } else {
        assert.match(result.stderr, /order order-test.*without a tracker/);
      }
      assert.doesNotMatch(result.stderr, /network forbidden/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

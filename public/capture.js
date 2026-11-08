const $ = (id) => document.getElementById(id);
const appClaim = new URLSearchParams(window.location.search).get("claim");
const appMode = !!appClaim && /^[a-f0-9-]{36}$/.test(appClaim);
const appToken = appMode ? new URLSearchParams(window.location.hash.slice(1)).get("token") || sessionStorage.getItem(`bof:capture:${appClaim}`) : null;
if (appMode) {
  if (appToken) sessionStorage.setItem(`bof:capture:${appClaim}`, appToken);
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  document.title = "Live photos, Break or Fake";
  $("order").hidden = true;
  $("order").required = false;
  if ($("order-field")) $("order-field").hidden = true;
  const label = document.querySelector('label[for="order"]');
  if (label) label.hidden = true;
  $("status").textContent = "Camera access requires a secure browser page.";
  const back = document.createElement("a");
  back.id = "app-back";
  back.className = "capture-back";
  back.textContent = "Back to your claim";
  back.href = `/claim/${appClaim}#token=${encodeURIComponent(appToken || "")}`;
  document.querySelector("main")?.append(back);
}
let stream, session, tick, cameraLabel;
let frames = [];
const status = (text) => { $("status").textContent = text; };
function stop() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  clearInterval(tick);
  $("camera").srcObject = null;
  $("challenge").hidden = true;
  $("start").disabled = false;
}
async function post(path, body) {
  const response = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json", ...(appMode && appToken ? { authorization: `Bearer ${appToken}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Capture failed");
  return result;
}
$("start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  stop();
  $("start").disabled = true;
  try {
    if (appMode && !appToken) throw new Error("Reopen the private camera link from your claim page.");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Open this page over HTTPS in Safari or Chrome.");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
    cameraLabel = appMode ? stream.getVideoTracks()[0]?.label : undefined;
    $("camera").srcObject = stream;
    await $("camera").play();
    session = await post(appMode ? `/api/claims/${appClaim}/capture-sessions` : "/sessions", appMode ? {} : { orderId: $("order").value });
    frames = [];
    $("previews").replaceChildren();
    $("code").textContent = session.code;
    $("direction").textContent = "Take the first frame straight on.";
    $("frame").textContent = "Take frame 1 of 3";
    $("frame").disabled = false;
    $("challenge").hidden = false;
    status("Session ready. Write the code on paper.");
    const update = () => {
      const remaining = Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000));
      $("timer").textContent = `${remaining} seconds remaining`;
      if (!remaining) { stop(); status("Session expired. Start again for a fresh code."); }
    };
    update();
    tick = setInterval(update, 500);
  } catch (error) {
    stop();
    status(error.message || "Camera unavailable. Open in Safari or Chrome, or ask the seller for help.");
  }
});
$("frame").addEventListener("click", async () => {
  $("frame").disabled = true;
  try {
    if (!stream || Date.now() >= session.expiresAt) throw new Error("Session expired. Start again.");
    const video = $("camera");
    if (!video.videoWidth || !video.videoHeight) throw new Error("Camera is not ready.");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", .9);
    frames.push({ mimeType: "image/jpeg", data: dataUrl.split(",")[1] });
    const preview = new Image();
    preview.src = dataUrl;
    preview.alt = `Captured frame ${frames.length}`;
    $("previews").append(preview);
    if (frames.length === 3) {
      status("Saving all three frames...");
      const result = await post(appMode ? `/api/claims/${appClaim}/capture-sessions/${session.id}/frames` : `/sessions/${session.id}/frames`, { orderId: session.orderId, nonce: session.nonce, frames, ...(appMode ? { cameraLabel } : {}) });
      stop();
      status(appMode ? "Your photos are saved. Return to your claim to see the review result." : `Saved capture ${result.id}. Awaiting measurement, no money moved.`);
    } else {
      $("direction").textContent = frames.length === 1 ? "Tilt a little to the left. Keep the code and damage visible." : "Tilt a little to the right. Keep the code and damage visible.";
      $("frame").textContent = `Take frame ${frames.length + 1} of 3`;
      $("frame").disabled = false;
    }
  } catch (error) {
    stop();
    status(error.message || "Capture failed. Start a new session.");
  }
});
$("cancel").addEventListener("click", () => { stop(); status("Capture cancelled. No decision was made."); });
window.addEventListener("pagehide", stop);

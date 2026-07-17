const devicesEl = document.querySelector("#devices");
const notice = document.querySelector("#notice");
const connection = document.querySelector("#connection");
const twofa = document.querySelector("#twofa");
const viewer = document.querySelector("#viewer");
const video = document.querySelector("#video");
let activeSerial;
let hls;

async function api(url, options) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}
function showError(error) { notice.textContent = error.message; setTimeout(() => { notice.textContent = ""; }, 7000); }
function escapeHtml(value) { const el = document.createElement("span"); el.textContent = String(value); return el.innerHTML; }

async function load() {
  try {
    const status = await api("/api/status");
    connection.className = `status ${status.state === "connected" ? "online" : ""}`;
    connection.querySelector("b").textContent = status.state.replaceAll("-", " ");
    twofa.classList.toggle("hidden", status.state !== "2fa-required");
    const devices = await api("/api/devices");
    renderDevices(devices);
  } catch (error) { showError(error); }
}
function renderDevices(devices) {
  const supported = devices.filter((d) => d.kind !== "other");
  if (!supported.length) { devicesEl.innerHTML = '<div class="empty">No supported camera or lock found yet.</div>'; return; }
  devicesEl.innerHTML = supported.map((d) => `
    <article class="card ${d.kind}">
      <div class="device-top"><span class="device-icon">${d.kind === "camera" ? "●" : "▣"}</span><span class="badge">${d.kind}</span></div>
      <h3>${escapeHtml(d.name)}</h3><p>${escapeHtml(d.model)} · ${escapeHtml(d.serial)}</p>
      <dl><div><dt>Battery</dt><dd>${d.battery ?? "—"}${typeof d.battery === "number" ? "%" : ""}</dd></div>${d.kind === "lock" ? `<div><dt>State</dt><dd>${d.locked === true ? "Locked" : d.locked === false ? "Unlocked" : "Unknown"}</dd></div>` : ""}</dl>
      <div class="actions">${d.kind === "camera" ? `
        <button data-stream="${escapeHtml(d.serial)}" data-name="${escapeHtml(d.name)}">Watch</button>
        <button class="secondary" data-record="${escapeHtml(d.serial)}" data-name="${escapeHtml(d.name)}">Watch & record</button>` : `
        <button data-lock="${escapeHtml(d.serial)}">Lock</button>
        <button class="danger" data-unlock="${escapeHtml(d.serial)}">Unlock</button>`}</div>
    </article>`).join("");
}

async function startStream(serial, name, record) {
  activeSerial = serial; document.querySelector("#viewer-title").textContent = name; viewer.showModal();
  document.querySelector("#viewer-state").textContent = record ? "Starting stream and local recording…" : "Starting secure local stream…";
  try {
    await api(`/api/devices/${encodeURIComponent(serial)}/stream`, { method: "POST", body: JSON.stringify({ record }) });
    let state;
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const candidate = await api(`/api/devices/${encodeURIComponent(serial)}/stream`);
        if (candidate.status === "failed") throw new Error(candidate.error || "Camera stream failed");
        if (candidate.status === "active" && candidate.playlist) { state = candidate; break; }
      } catch (error) {
        if (!error.message.includes("not ready")) throw error;
      }
    }
    if (!state) throw new Error("Camera did not begin streaming within 30 seconds");
    await play(state.playlist);
    document.querySelector("#viewer-state").textContent = state.recording ? "Live · recording locally" : "Live";
  } catch (error) {
    if (activeSerial) await api(`/api/devices/${encodeURIComponent(activeSerial)}/stream`, { method: "DELETE" }).catch(() => {});
    showError(error); document.querySelector("#viewer-state").textContent = error.message;
  }
}
function play(url) {
  return new Promise((resolve, reject) => {
    if (window.Hls?.isSupported()) {
      hls = new Hls({ liveSyncDurationCount: 2 });
      hls.on(Hls.Events.MANIFEST_PARSED, async () => {
        try { await video.play(); resolve(); } catch (error) { reject(error); }
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) reject(new Error(`Video playback failed: ${data.details}`));
      });
      hls.loadSource(url); hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("The browser rejected the camera stream")), { once: true });
      video.src = url;
    } else reject(new Error("This browser cannot play HLS video"));
  });
}
async function stopStream() {
  if (activeSerial) await api(`/api/devices/${encodeURIComponent(activeSerial)}/stream`, { method: "DELETE" }).catch(showError);
  hls?.destroy(); hls = undefined; video.removeAttribute("src"); video.load(); activeSerial = undefined; viewer.close(); loadRecordings();
}
async function setLock(serial, locked) {
  const verb = locked ? "lock" : "UNLOCK";
  if (!confirm(`${verb} this device?`)) return;
  try { await api(`/api/devices/${encodeURIComponent(serial)}/lock`, { method: "POST", body: JSON.stringify({ locked }) }); setTimeout(load, 1500); }
  catch (error) { showError(error); }
}
async function loadRecordings() {
  try {
    const files = await api("/api/recordings");
    document.querySelector("#recordings-list").innerHTML = files.length ? files.map((f) => `<a href="${f.url}" target="_blank"><span>${escapeHtml(f.name)}</span><small>${(f.size / 1048576).toFixed(1)} MB</small></a>`).join("") : '<div class="empty">No recordings yet.</div>';
  } catch (error) { showError(error); }
}

devicesEl.addEventListener("click", (event) => {
  const button = event.target.closest("button"); if (!button) return;
  if (button.dataset.stream) startStream(button.dataset.stream, button.dataset.name, false);
  if (button.dataset.record) startStream(button.dataset.record, button.dataset.name, true);
  if (button.dataset.lock) setLock(button.dataset.lock, true);
  if (button.dataset.unlock) setLock(button.dataset.unlock, false);
});
document.querySelector("#refresh").addEventListener("click", load);
document.querySelector("#recordings-refresh").addEventListener("click", loadRecordings);
document.querySelector("#stream-stop").addEventListener("click", stopStream);
document.querySelector("#viewer-close").addEventListener("click", stopStream);
document.querySelector("#twofa-form").addEventListener("submit", async (event) => {
  event.preventDefault(); try { await api("/api/auth/2fa", { method: "POST", body: JSON.stringify({ code: document.querySelector("#twofa-code").value }) }); setTimeout(load, 1000); } catch (error) { showError(error); }
});
load(); loadRecordings(); setInterval(load, 15000);

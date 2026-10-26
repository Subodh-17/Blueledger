// Shared interface behaviour: notifications, accessible dialogs, maps and charts drawn from real data.
import { html, raw, esc, icon } from "./util.js";

const toastBox = () => document.getElementById("toasts");
export function toast(msg, kind = "") {
  const d = document.createElement("div"); d.className = `toast ${kind}`; d.textContent = msg; toastBox().appendChild(d);
  setTimeout(() => d.remove(), kind === "error" ? 9000 : 4500);
}
export const announce = (msg) => { const a = document.getElementById("sr-announce"); a.textContent = ""; setTimeout(() => { a.textContent = msg; }, 50); };

// ── modal dialog with focus trap; resolves to { ok, reason } ──
export function confirmDialog({ title, body, confirmLabel = "Confirm", danger = false, reasonLabel, reasonRequired = false, reasonMin = 5 }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const back = document.createElement("div"); back.className = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-b"><h2 id="dlg-t">${esc(title)}</h2><div id="dlg-b">${body?.s ?? esc(body || "")}</div>
      ${reasonLabel ? `<label for="dlg-r">${esc(reasonLabel)}${reasonRequired ? '<span class="req" aria-hidden="true">*</span>' : ' <span class="opt">(optional)</span>'}</label><textarea id="dlg-r" maxlength="1000"></textarea><div class="field-error" id="dlg-e" role="alert"></div>` : ""}
      <div class="foot"><button type="button" class="secondary" data-x="cancel">Cancel</button><button type="button" class="${danger ? "danger" : "primary"}" data-x="ok">${esc(confirmLabel)}</button></div></div>`;
    document.body.appendChild(back);
    const modal = back.firstElementChild, q = (s) => modal.querySelector(s);
    const close = (res) => { back.remove(); document.removeEventListener("keydown", key, true); opener?.focus?.(); resolve(res); };
    const key = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close({ ok: false }); }
      if (e.key === "Tab") { const f = [...modal.querySelectorAll("button,textarea,input,select,a[href]")].filter((x) => !x.disabled); const i = f.indexOf(document.activeElement); if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } }
    };
    document.addEventListener("keydown", key, true);
    q("[data-x=cancel]").onclick = () => close({ ok: false });
    q("[data-x=ok]").onclick = () => {
      const reason = (q("#dlg-r")?.value || "").trim();
      if (reasonRequired && reason.length < reasonMin) { q("#dlg-e").textContent = `Enter at least ${reasonMin} characters.`; q("#dlg-r").setAttribute("aria-invalid", "true"); q("#dlg-r").focus(); return; }
      close({ ok: true, reason });
    };
    back.addEventListener("mousedown", (e) => { if (e.target === back) close({ ok: false }); });
    (q("#dlg-r") || q("[data-x=ok]")).focus();
  });
}

// ── map: tiles positioned from real coordinates (Web Mercator) with the project boundary / markers drawn on top ──
const mx = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
const my = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z; };
export function mapView({ points = [], polygon = null, tileUrl, attribution, label, width = 760, height = 420, markerHref }) {
  const all = [...points.map((p) => [p.lat, p.lon]), ...(polygon || []).map(([lon, lat]) => [lat, lon])].filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (!all.length) return html`<p class="muted">No coordinates are recorded.</p>`;
  const lats = all.map((p) => p[0]), lons = all.map((p) => p[1]);
  let z = 15;
  for (; z > 2; z--) { const w = mx(Math.max(...lons), z) - mx(Math.min(...lons), z), h = my(Math.min(...lats), z) - my(Math.max(...lats), z); if (w < width * 0.62 && h < height * 0.62) break; }
  const cx = mx((Math.min(...lons) + Math.max(...lons)) / 2, z), cy = my((Math.min(...lats) + Math.max(...lats)) / 2, z);
  const ox = cx - width / 2, oy = cy - height / 2, sx = (lon) => mx(lon, z) - ox, sy = (lat) => my(lat, z) - oy;
  const tiles = [];
  if (tileUrl) for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + width) / 256); tx++) for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + height) / 256); ty++) {
    if (ty < 0 || ty >= 2 ** z) continue;
    const u = tileUrl.replace("{z}", z).replace("{x}", ((tx % 2 ** z) + 2 ** z) % 2 ** z).replace("{y}", ty);
    tiles.push(`<image data-tile="1" href="${esc(u)}" x="${(tx * 256 - ox).toFixed(1)}" y="${(ty * 256 - oy).toFixed(1)}" width="256" height="256"/>`);
  }
  const poly = polygon ? `<polygon points="${polygon.map(([lon, lat]) => `${sx(lon).toFixed(1)},${sy(lat).toFixed(1)}`).join(" ")}" fill="#157f78" fill-opacity=".28" stroke="#0b2237" stroke-width="2.5"/>` : "";
  const marks = points.map((p) => { const g = `<circle cx="${sx(p.lon).toFixed(1)}" cy="${sy(p.lat).toFixed(1)}" r="8" fill="#0b2237" stroke="#fff" stroke-width="2.5"/><title>${esc(p.label)} (${p.lat.toFixed(5)}, ${p.lon.toFixed(5)})</title>`; return markerHref ? `<a href="${esc(markerHref(p))}" aria-label="${esc(p.label)}">${g}</a>` : `<g>${g}</g>`; }).join("");
  const scale = (156543.03392 * Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180)) / 2 ** z; // metres per pixel
  const bar = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000].find((m) => m / scale > 70) || 100000;
  return html`<figure class="mapfig"><svg class="map" viewBox="0 0 ${width} ${height}" role="${markerHref ? "group" : "img"}" aria-label="${label}"><rect width="${width}" height="${height}" fill="#e3f4f1"/>${raw(tiles.join(""))}${raw(poly)}${raw(marks)}
    <g transform="translate(14 ${height - 26})"><rect x="-6" y="-14" width="${(bar / scale + 12).toFixed(0)}" height="30" fill="#fff" fill-opacity=".85" rx="4"/><line x1="0" y1="6" x2="${(bar / scale).toFixed(1)}" y2="6" stroke="#0b2237" stroke-width="3"/><text x="0" y="-2" font-size="11" fill="#0b2237">${bar >= 1000 ? bar / 1000 + " km" : bar + " m"}</text></g></svg>
    <figcaption class="map-note" data-map-note>${tileUrl ? raw(`Basemap: ${esc(attribution || "")}. Positions use the coordinates recorded in the registry.`) : "No basemap is configured; positions use the coordinates recorded in the registry."}</figcaption></figure>`;
}
/** After inserting a map, report when basemap tiles cannot be loaded (offline, blocked or unconfigured). */
export function watchTiles(root) {
  root.querySelectorAll("figure.mapfig").forEach((fig) => {
    const tiles = [...fig.querySelectorAll("image[data-tile]")]; if (!tiles.length) return;
    let failed = 0, ok = 0; const note = fig.querySelector("[data-map-note]");
    const check = () => { if (failed === tiles.length) note.textContent = "Basemap tiles could not be loaded. Boundaries and markers are drawn at their recorded coordinates."; };
    tiles.forEach((t) => { t.addEventListener("error", () => { failed++; check(); }); t.addEventListener("load", () => ok++); });
    setTimeout(() => { if (!ok && !failed) { failed = tiles.length; check(); } }, 8000);
  });
}

// ── charts (SVG) computed from the supplied series; always labelled with units and period ──
export function barChart({ labels, series, unit, title, desc }) {
  const W = 720, H = 260, m = { l: 46, r: 10, t: 12, b: 38 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(1, ...series.flatMap((s) => s.values)), top = niceMax(max);
  const gw = iw / labels.length, bw = Math.max(3, Math.min(26, (gw - 6) / series.length));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  const bars = labels.map((l, i) => series.map((s, k) => { const v = s.values[i], h = (v / top) * ih; return `<rect class="s${k}" x="${(m.l + i * gw + (gw - bw * series.length) / 2 + k * bw).toFixed(1)}" y="${(m.t + ih - h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}"><title>${esc(s.name)}, ${esc(l)}: ${v} ${esc(unit)}</title></rect>`; }).join("")).join("");
  const xl = labels.map((l, i) => (i % Math.ceil(labels.length / 12) === 0 ? `<text x="${(m.l + i * gw + gw / 2).toFixed(1)}" y="${H - 18}" font-size="10.5" text-anchor="middle">${esc(l.slice(2))}</text>` : "")).join("");
  const yl = ticks.map((t) => `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${(m.t + ih - (t / top) * ih).toFixed(1)}" y2="${(m.t + ih - (t / top) * ih).toFixed(1)}"/><text x="${m.l - 6}" y="${(m.t + ih - (t / top) * ih + 4).toFixed(1)}" font-size="10.5" text-anchor="end">${Number.isInteger(t) ? t : t.toFixed(1)}</text>`).join("");
  return html`<figure><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}. ${desc || ""}">${raw(yl + bars + xl)}<text x="${m.l}" y="${H - 3}" font-size="10.5">Month (YY-MM) · values in ${esc(unit)}</text></svg>
    <div class="legend">${series.map((s, k) => html`<span><i class="chart-key s${k}"></i>${s.name}</span>`)}</div></figure>`;
}
const niceMax = (v) => { const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };

export async function copyText(text) { try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); } catch { toast("Copy is not available in this browser; select the value and copy it manually.", "warn"); } }

/** Information-only dialog (focus trapped, Escape closes). */
export function infoDialog({ title, body, closeLabel = "Close" }) {
  return new Promise((resolve) => {
    const opener = document.activeElement, back = document.createElement("div"); back.className = "modal-back";
    back.innerHTML = `<div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="dlg-t"><h2 id="dlg-t">${esc(title)}</h2><div>${body?.s ?? esc(body || "")}</div><div class="foot"><button type="button" class="secondary" data-x="close">${esc(closeLabel)}</button></div></div>`;
    document.body.appendChild(back);
    const close = () => { back.remove(); document.removeEventListener("keydown", key, true); opener?.focus?.(); resolve(); };
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } if (e.key === "Tab") { e.preventDefault(); back.querySelector("[data-x=close]").focus(); } };
    document.addEventListener("keydown", key, true);
    back.querySelector("[data-x=close]").onclick = close; back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
    back.querySelector("[data-x=close]").focus();
  });
}

// Evidence presentation shared by the record workspace and the evidence repository.
import { html, badge, name, num, fmtDate, fmtTime, bytes, hash, esc } from "../util.js";
import { infoDialog } from "../ui.js";

export const metaSummary = (m) => {
  if (!m) return html`<span class="muted">No file metadata</span>`;
  const bits = [];
  if (m.width) bits.push(`${m.width} × ${m.height} px`);
  if (m.embeddedCaptureTime) bits.push(`embedded capture time ${fmtTime(m.embeddedCaptureTime)}`);
  if (m.embeddedLatitude != null) bits.push(`embedded location ${m.embeddedLatitude.toFixed(5)}, ${m.embeddedLongitude.toFixed(5)}`);
  if (m.device) bits.push(m.device);
  return bits.length ? bits.join(" · ") : html`<span class="muted">No embedded capture metadata</span>`;
};

export function evidenceCard(e, { review = false } = {}) {
  const previewable = e.storage_status === "STORED" && e.mime_type?.startsWith("image/");
  return html`<article class="ev" aria-label="Evidence ${e.code}">${previewable ? html`<img class="thumb" data-evid="${e.id}" alt="Preview of ${e.filename || e.code}">` : html`<div class="thumb">${e.storage_status === "REFERENCE_ONLY" ? "Reference only: no file held" : e.storage_status === "MISSING" ? "Stored file is missing" : "No preview available"}</div>`}
    <div><strong>${e.code}</strong> ${badge("evidence", e.verification_status)}</div><div class="small">${name("kind", e.kind)}${e.filename ? html` · ${e.filename}` : ""}${e.size_bytes ? ` · ${bytes(e.size_bytes)}` : ""}</div>
    <div class="small">${e.sha256 ? html`SHA-256 ${hash("0x" + e.sha256, 8)}` : html`Reference: ${e.external_ref}`}</div>
    <div class="small">${badge("storage", e.storage_status)} ${badge("ipfs", e.ipfs_status)}${e.ipfs_cid ? html` <code>${e.ipfs_cid}</code>` : ""}</div>
    <div class="small muted">${metaSummary(e.file_metadata)}${e.platform ? html`<br>Platform: ${e.platform}${e.altitude_m ? `, ${e.altitude_m} m` : ""}` : ""}</div>
    ${e.review_notes ? html`<div class="small">Review note: ${e.review_notes}</div>` : ""}
    <div class="flex">${e.storage_status === "STORED" ? html`<button type="button" class="secondary sm" data-action="ev-view" data-id="${e.id}" data-name="${e.filename || e.code}" data-image="${previewable ? 1 : 0}">${previewable ? "Preview" : "Open"}</button><button type="button" class="secondary sm" data-action="ev-download" data-id="${e.id}" data-name="${e.filename || e.code}">Download</button>` : ""}
      ${review ? html`${e.verification_status !== "VERIFIED" ? html`<button type="button" class="primary sm" data-action="ev-review" data-d="VERIFIED" data-id="${e.id}" data-code="${e.code}">Accept</button>` : ""}<button type="button" class="secondary sm" data-action="ev-review" data-d="NEEDS_REVISION" data-id="${e.id}" data-code="${e.code}">Request revision</button><button type="button" class="danger sm" data-action="ev-review" data-d="REJECTED" data-id="${e.id}" data-code="${e.code}">Reject</button>` : ""}</div></article>`;
}

export function loadThumbs(ctx, root) {
  root.querySelectorAll("img[data-evid]").forEach((img) => ctx.api.blobUrl(`/evidence/${img.dataset.evid}/file`).then((u) => { img.src = u; }).catch(() => { img.replaceWith(Object.assign(document.createElement("div"), { className: "thumb", textContent: "Preview unavailable" })); }));
}

/** Register preview / download / review handlers on the current page. */
export function evidenceActions(ctx, { onReviewed } = {}) {
  ctx.on("ev-view", async (b) => {
    const url = await ctx.run(b, () => ctx.api.blobUrl(`/evidence/${b.dataset.id}/file`));
    if (b.dataset.image === "1") await infoDialog({ title: b.dataset.name, body: html`<img class="preview" src="${url}" alt="${b.dataset.name}"><p class="small muted">Shown from the stored file. The content hash identifies this exact file; it does not establish that what it shows is accurate.</p>` });
    else window.open(url, "_blank", "noopener");
  });
  ctx.on("ev-download", async (b) => {
    const url = await ctx.run(b, () => ctx.api.blobUrl(`/evidence/${b.dataset.id}/file?download=1`));
    const a = document.createElement("a"); a.href = url; a.download = b.dataset.name; document.body.appendChild(a); a.click(); a.remove();
  });
  ctx.on("ev-review", async (b) => {
    const d = b.dataset.d, accept = d === "VERIFIED";
    const r = await ctx.confirm({ title: accept ? `Accept ${b.dataset.code}?` : d === "REJECTED" ? `Reject ${b.dataset.code}?` : `Request revision of ${b.dataset.code}?`, body: accept ? "Mark this evidence item as reviewed and accepted for this record." : "The reason is stored with the review and shown to the submitter.", confirmLabel: accept ? "Accept evidence" : d === "REJECTED" ? "Reject evidence" : "Request revision", danger: d === "REJECTED", reasonLabel: accept ? "Review note" : "Reason", reasonRequired: !accept });
    if (!r.ok) return;
    await ctx.run(b, () => ctx.api.post(`/evidence/${b.dataset.id}/review`, { decision: d, notes: r.reason }), "Evidence review recorded");
    onReviewed ? onReviewed() : ctx.refresh();
  });
}

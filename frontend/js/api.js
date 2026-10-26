// REST client. The signed-in token lives in sessionStorage (cleared when the tab closes).
const KEY = "bcr_token";
export const getToken = () => sessionStorage.getItem(KEY);
export const setToken = (t) => (t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY));

// Base API origin: defaults to relative /api, or uses window.__API_BASE__ / localStorage("API_BASE") if deployed cross-origin.
export const getApiBase = () => (typeof window !== "undefined" && (window.__API_BASE__ || window.localStorage?.getItem("API_BASE") || "")) || "";
export const setApiBase = (base) => { if (typeof window !== "undefined" && window.localStorage) { base ? localStorage.setItem("API_BASE", base) : localStorage.removeItem("API_BASE"); } };
const apiUrl = (path) => `${getApiBase()}/api${path}`;

function fail(res, data) {
  const d = data?.details;
  const detail = d && !d.operationId && !d.txHash ? " — " + (d.failed ? d.failed.map((f) => f.detail).join("; ") : Object.entries(d).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("; ")) : "";
  return Object.assign(new Error((data?.error || `Request failed (${res.status})`) + detail), { status: res.status, details: d, requestId: data?.requestId });
}
async function request(method, path, body) {
  const headers = {}; const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try { res = await fetch(apiUrl(path), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error("The server cannot be reached. Check your connection and try again."), { network: true }); }
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw fail(res, data);
  return data;
}
const qs = (o) => { const p = new URLSearchParams(Object.entries(o || {}).filter(([, v]) => v !== "" && v != null)); return p.toString() ? `?${p}` : ""; };

export const api = {
  get: (p, query) => request("GET", p + qs(query)),
  post: (p, b) => request("POST", p, b || {}), put: (p, b) => request("PUT", p, b), patch: (p, b) => request("PATCH", p, b),
  delete: (p, b) => request("DELETE", p, b || {}),
  /** Multipart upload with progress callback (0-100). */
  upload(path, form, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", apiUrl(path));
      if (getToken()) x.setRequestHeader("authorization", `Bearer ${getToken()}`);
      x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
      x.onerror = () => reject(Object.assign(new Error("The upload could not be completed. Check your connection and try again."), { network: true }));
      x.onload = () => { let data = null; try { data = JSON.parse(x.responseText); } catch { /* not json */ } x.status >= 200 && x.status < 300 ? resolve(data) : reject(fail({ status: x.status }, data)); };
      x.send(form);
    });
  },
  async blobUrl(path) {
    const res = await fetch(apiUrl(path), { headers: { authorization: `Bearer ${getToken()}` } });
    if (!res.ok) { const d = await res.json().catch(() => null); throw Object.assign(new Error(d?.error || "File unavailable"), { status: res.status }); }
    return URL.createObjectURL(await res.blob());
  },
};

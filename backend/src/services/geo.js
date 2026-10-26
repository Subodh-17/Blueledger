// backend/src/services/geo.js — validation of GeoJSON field-survey and drone-derived geospatial files.
//
// Pure functions (no database, no network). The checks establish that a file is well formed, uses WGS 84 longitude/latitude, and where
// it lies relative to the project's configured boundary. They do NOT establish that the file is true: a valid file can still be wrong,
// which is why every import goes to human review as evidence. Counts found in the file are reported as an unreviewed summary; they
// are never written into the record's measurements.
//
// Import contract (GeoJSON, RFC 7946 subset)
//   FeatureCollection | Feature | geometry, coordinates [longitude, latitude(, altitude)] in EPSG:4326 (a "crs" member, if present, must say so).
//   Geometry types: Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon. (GeometryCollection is rejected.)
//   Optional feature properties: observedAt / capturedAt (YYYY-MM-DD or ISO date-time, not in the future), species (text),
//   count (whole number >= 0), unit (text), collector (text), sensor (text). Wrong types are errors; missing species/count on point
//   features is a warning, and those points are left out of the species summary.
//   Containment: every Point must lie inside the project boundary. Lines and polygons must have at least one vertex inside; a partial
//   overlap is a warning (orthomosaic footprints legitimately extend past a boundary).
const MB = 1024 * 1024;
const LIMITS = { maxBytes: Number(process.env.GEO_MAX_BYTES) || 5 * MB, maxFeatures: Number(process.env.GEO_MAX_FEATURES) || 5000, maxVertices: Number(process.env.GEO_MAX_VERTICES) || 250000, maxErrors: 25 };
const TYPES = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"];
const EPS = 1e-9, RING_CHECK_MAX = 1500, SAMPLE_MAX = 2000;

const isPos = (p) => Array.isArray(p) && (p.length === 2 || p.length === 3) && p.every((n) => typeof n === "number" && Number.isFinite(n));
const inRange = (p) => p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;

/** Ray casting with an on-edge tolerance. ring: array of [lon, lat]. */
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    // on-segment (inclusive boundary)
    const cross = (pt[1] - yi) * (xj - xi) - (pt[0] - xi) * (yj - yi);
    if (Math.abs(cross) <= EPS && pt[0] >= Math.min(xi, xj) - EPS && pt[0] <= Math.max(xi, xj) + EPS && pt[1] >= Math.min(yi, yj) - EPS && pt[1] <= Math.max(yi, yj) + EPS) return true;
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (pt, rings) => inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h) && !onRing(pt, h));
function onRing(pt, ring) { for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (Math.abs((pt[1] - yi) * (xj - xi) - (pt[0] - xi) * (yj - yi)) <= EPS && pt[0] >= Math.min(xi, xj) - EPS && pt[0] <= Math.max(xi, xj) + EPS && pt[1] >= Math.min(yi, yj) - EPS && pt[1] <= Math.max(yi, yj) + EPS) return true; } return false; }
/** The project's boundary as a list of polygons (each a list of rings), or null when unusable. */
function boundaryPolygons(g) {
  try {
    if (!g || typeof g !== "object") return null;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null;
    if (!polys || !polys.length) return null;
    for (const rings of polys) { if (!Array.isArray(rings) || !rings.length) return null; for (const r of rings) if (!Array.isArray(r) || r.length < 4 || !r.every((p) => isPos(p) && inRange(p))) return null; }
    return polys;
  } catch { return null; }
}
const inBoundary = (pt, polys) => polys.some((rings) => inPolygon(pt, rings));

function segIntersect(a, b, c, d) { // proper or touching intersection of segments ab and cd
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const on = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}
function selfIntersects(ring) {
  const n = ring.length - 1; // last point repeats the first
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges share a vertex
    if (segIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
  }
  return false;
}
// All positions on one straight line. (Signed area alone is not used: a self-crossing "bowtie" can have a net area of zero.)
const collinear = (ring) => { const a = ring[0], b = ring.find((p) => p[0] !== a[0] || p[1] !== a[1]); if (!b) return true; return ring.every((p) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) <= EPS); };
const validDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v.slice(0, 10)).toISOString().slice(0, 10) === v.slice(0, 10);

function validate(input, { boundary = null, limits = {} } = {}) {
  const L = { ...LIMITS, ...limits };
  const errors = [], warnings = [];
  const err = (code, message, path) => { if (errors.length < L.maxErrors) errors.push({ code, message, ...(path ? { path } : {}) }); else if (errors.length === L.maxErrors) errors.push({ code: "MORE_ERRORS", message: "Further errors are not listed." }); };
  const warn = (code, message, path) => { if (warnings.length < L.maxErrors) warnings.push({ code, message, ...(path ? { path } : {}) }); };
  const result = (extra = {}) => ({ valid: errors.length === 0, errors, warnings, summary: null, boundary: null, ...extra });

  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
  if (buf.length === 0) { err("EMPTY_FILE", "The file is empty."); return result(); }
  if (buf.length > L.maxBytes) { err("TOO_LARGE", `The file is ${(buf.length / MB).toFixed(1)} MB; the limit is ${(L.maxBytes / MB).toFixed(0)} MB.`); return result(); }
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { err("BAD_ENCODING", "The file is not valid UTF-8 text."); return result(); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let doc; try { doc = JSON.parse(text); } catch (e) { err("MALFORMED_JSON", `The file is not valid JSON (${String(e.message).slice(0, 120)}).`); return result(); }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc) || typeof doc.type !== "string") { err("NOT_GEOJSON", "The file is JSON but not GeoJSON: a top-level object with a string \"type\" is required."); return result(); }

  if (doc.crs != null) {
    const n = String(doc.crs?.properties?.name ?? "");
    if (!/(EPSG::?4326|CRS84)$/i.test(n)) err("UNSUPPORTED_CRS", `Only WGS 84 longitude/latitude (EPSG:4326) is supported; the file declares "${n.slice(0, 60) || "an unreadable CRS"}". Reproject before importing.`);
  }
  let features;
  if (doc.type === "FeatureCollection") features = Array.isArray(doc.features) ? doc.features : (err("NOT_GEOJSON", "A FeatureCollection needs a \"features\" array."), []);
  else if (doc.type === "Feature") features = [doc];
  else if (TYPES.includes(doc.type) || doc.type === "GeometryCollection") features = [{ type: "Feature", properties: null, geometry: doc }];
  else { err("NOT_GEOJSON", `Unknown GeoJSON type "${String(doc.type).slice(0, 40)}".`); return result(); }
  if (errors.length && !features.length) return result();
  if (features.length === 0) { err("NO_FEATURES", "The file contains no features."); return result(); }
  if (features.length > L.maxFeatures) { err("TOO_MANY_FEATURES", `The file has ${features.length} features; the limit is ${L.maxFeatures}.`); return result(); }

  const polys = boundary ? boundaryPolygons(boundary) : null;
  const summary = { featureCount: features.length, geometryTypes: {}, vertexCount: 0, bbox: null, speciesTotals: {}, pointsWithoutSpeciesOrCount: 0, pointCount: 0, observationDates: { first: null, last: null } };
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const pts = [], verts = [], badPoints = [], outsideShapes = [], partial = [];
  let aborted = false;

  const takePos = (p, path, owner, isPoint) => {
    if (!isPos(p)) { err("BAD_COORDINATE", "A position must be [longitude, latitude] (optionally with altitude), all finite numbers.", path); return false; }
    if (!inRange(p)) { err("COORDINATE_OUT_OF_RANGE", `Longitude must be -180..180 and latitude -90..90 (found ${p[0]}, ${p[1]}). Check that the order is [longitude, latitude].`, path); return false; }
    if (++summary.vertexCount > L.maxVertices) { aborted = true; return false; }
    bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]);
    if (polys) (isPoint ? pts : verts).push({ p, owner });
    return true;
  };
  const ringChecks = (ring, path) => {
    if (!Array.isArray(ring) || ring.length < 4) return err("RING_TOO_SHORT", "A polygon ring needs at least 4 positions (the first repeated as the last).", path);
    const ok = ring.every((p, i) => takePos(p, `${path}[${i}]`, null, false)); if (!ok || aborted) return;
    const a = ring[0], z = ring[ring.length - 1];
    if (a[0] !== z[0] || a[1] !== z[1]) return err("UNCLOSED_RING", "A polygon ring must end at the position where it starts.", path);
    if (collinear(ring)) return err("ZERO_AREA", "The polygon ring has no area (all positions lie on one line).", path);
    if (ring.length > RING_CHECK_MAX) return warn("SELF_INTERSECTION_NOT_CHECKED", `A ring with ${ring.length} positions was not checked for self-intersection (limit ${RING_CHECK_MAX}).`, path);
    if (selfIntersects(ring)) err("SELF_INTERSECTION", "The polygon ring crosses itself.", path);
  };

  features.forEach((f, i) => {
    if (aborted) return;
    const fp = `features[${i}]`;
    if (!f || typeof f !== "object" || f.type !== "Feature") return err("NOT_A_FEATURE", "Every entry of \"features\" must be a GeoJSON Feature.", fp);
    const g = f.geometry;
    if (g == null) return err("NULL_GEOMETRY", "A feature has no geometry.", fp);
    if (typeof g !== "object" || !TYPES.includes(g.type)) return err("UNSUPPORTED_GEOMETRY", `Geometry type "${String(g?.type).slice(0, 30)}" is not supported (allowed: ${TYPES.join(", ")}).`, `${fp}.geometry`);
    summary.geometryTypes[g.type] = (summary.geometryTypes[g.type] || 0) + 1;
    const c = g.coordinates, cp = `${fp}.geometry.coordinates`, owner = i;
    const beforeErrors = errors.length;
    switch (g.type) {
      case "Point": if (takePos(c, cp, owner, true)) summary.pointCount++; break;
      case "MultiPoint": if (!Array.isArray(c) || !c.length) err("BAD_COORDINATE", "A MultiPoint needs at least one position.", cp); else c.forEach((p, k) => { if (takePos(p, `${cp}[${k}]`, owner, true)) summary.pointCount++; }); break;
      case "LineString": if (!Array.isArray(c) || c.length < 2) err("LINE_TOO_SHORT", "A LineString needs at least 2 positions.", cp); else c.forEach((p, k) => takePos(p, `${cp}[${k}]`, owner, false)); break;
      case "MultiLineString": if (!Array.isArray(c) || !c.length) err("LINE_TOO_SHORT", "A MultiLineString needs at least one line.", cp); else c.forEach((l, k) => { if (!Array.isArray(l) || l.length < 2) err("LINE_TOO_SHORT", "A line needs at least 2 positions.", `${cp}[${k}]`); else l.forEach((p, m) => takePos(p, `${cp}[${k}][${m}]`, owner, false)); }); break;
      case "Polygon": if (!Array.isArray(c) || !c.length) err("RING_TOO_SHORT", "A Polygon needs at least one ring.", cp); else c.forEach((r, k) => ringChecks(r, `${cp}[${k}]`)); break;
      case "MultiPolygon": if (!Array.isArray(c) || !c.length) err("RING_TOO_SHORT", "A MultiPolygon needs at least one polygon.", cp); else c.forEach((poly, k) => { if (!Array.isArray(poly) || !poly.length) err("RING_TOO_SHORT", "A polygon needs at least one ring.", `${cp}[${k}]`); else poly.forEach((r, m) => ringChecks(r, `${cp}[${k}][${m}]`)); }); break;
    }
    // properties
    const pr = f.properties;
    if (pr != null && (typeof pr !== "object" || Array.isArray(pr))) return err("BAD_PROPERTY", "\"properties\" must be an object or null.", `${fp}.properties`);
    const props = pr || {};
    for (const k of ["observedAt", "capturedAt"]) if (props[k] != null) { if (!validDate(props[k])) err("BAD_PROPERTY", `${k} must be a calendar date or ISO date-time.`, `${fp}.properties.${k}`); else if (props[k].slice(0, 10) > today) err("BAD_PROPERTY", `${k} is in the future.`, `${fp}.properties.${k}`); else { const d = props[k].slice(0, 10); const o = summary.observationDates; if (!o.first || d < o.first) o.first = d; if (!o.last || d > o.last) o.last = d; } }
    for (const k of ["species", "unit", "collector", "sensor"]) if (props[k] != null && (typeof props[k] !== "string" || !props[k].trim() || props[k].length > 120)) err("BAD_PROPERTY", `${k} must be non-empty text of at most 120 characters.`, `${fp}.properties.${k}`);
    if (props.count != null && (!Number.isInteger(props.count) || props.count < 0 || props.count > 1e7)) err("BAD_PROPERTY", "count must be a whole number from 0 to 10,000,000.", `${fp}.properties.count`);
    if (g.type === "Point" && errors.length === beforeErrors) {
      if (typeof props.species === "string" && Number.isInteger(props.count)) { const sp = props.species.trim(); summary.speciesTotals[sp] = (summary.speciesTotals[sp] || 0) + props.count; }
      else summary.pointsWithoutSpeciesOrCount++;
    }
  });
  if (aborted) { err("TOO_MANY_VERTICES", `The file has more than ${L.maxVertices} positions, which is the limit.`); return result({ summary: null }); }
  if (summary.pointsWithoutSpeciesOrCount) warn("MISSING_PROPERTIES", `${summary.pointsWithoutSpeciesOrCount} of ${summary.pointCount} point feature(s) have no species and whole-number count; they are kept as evidence but excluded from the species summary.`);
  if (Number.isFinite(bb[0])) summary.bbox = bb.map((n) => Number(n.toFixed(7)));

  // Containment in the project boundary.
  let bnd;
  if (!boundary) bnd = { status: "NO_BOUNDARY", checked: false, message: "The project has no configured boundary, so containment was not validated. Add a boundary to the project to enable this check." };
  else if (!polys) bnd = { status: "BOUNDARY_UNUSABLE", checked: false, message: "The project's stored boundary is not a usable Polygon or MultiPolygon, so containment was not validated." };
  else if (!summary.vertexCount) bnd = { status: "NOT_APPLICABLE", checked: false, message: "No valid positions were found to compare with the boundary." };
  else {
    const insidePts = pts.filter((x) => inBoundary(x.p, polys)), outPts = pts.filter((x) => !insidePts.includes(x));
    const step = Math.max(1, Math.ceil(verts.length / SAMPLE_MAX)), sample = verts.filter((_, k) => k % step === 0);
    const by = new Map(); for (const x of sample) { const e = by.get(x.owner) || { total: 0, inside: 0 }; e.total++; if (inBoundary(x.p, polys)) e.inside++; by.set(x.owner, e); }
    for (const [owner, e] of by) { if (e.inside === 0) outsideShapes.push(owner); else if (e.inside < e.total) partial.push({ owner, pct: Math.round((100 * e.inside) / e.total) }); }
    const total = pts.length + sample.length, inside = insidePts.length + [...by.values()].reduce((n, e) => n + e.inside, 0);
    const fraction = total ? inside / total : null;
    bnd = { status: fraction === 1 ? "INSIDE" : fraction === 0 ? "OUTSIDE" : "PARTIAL", checked: true, insideFraction: fraction == null ? null : Number(fraction.toFixed(4)), pointsChecked: pts.length, pointsOutside: outPts.length, shapesChecked: by.size, shapesOutside: outsideShapes.length, sampled: step > 1 };
    const swapped = outPts.filter((x) => inRange([x.p[1], x.p[0]]) && inBoundary([x.p[1], x.p[0]], polys)).length;
    if (outPts.length) err("POINT_OUTSIDE_BOUNDARY", `${outPts.length} point(s) lie outside the project boundary (first at features[${outPts.slice(0, 5).map((x) => x.owner).join("], features[")}]).${swapped ? ` ${swapped} of them would be inside if latitude and longitude were swapped: coordinates must be [longitude, latitude].` : ""}`);
    if (outsideShapes.length) err("OUTSIDE_BOUNDARY", `${outsideShapes.length} line/polygon feature(s) have no position inside the project boundary (first at features[${outsideShapes.slice(0, 5).join("], features[")}]).`);
    for (const x of partial.slice(0, 5)) warn("PARTIAL_OVERLAP", `features[${x.owner}] is only partly inside the project boundary (${x.pct}% of its positions).`);
  }
  return result({ summary, boundary: bnd });
}

module.exports = { validate, boundaryPolygons, inBoundary, LIMITS, TYPES };

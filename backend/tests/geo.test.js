// Unit tests for the GeoJSON validator (pure functions; no database).
const test = require("node:test");
const assert = require("node:assert/strict");
const geo = require("../src/services/geo");

const BOUNDARY = { type: "Polygon", coordinates: [[[82.0, 16.7], [82.4, 16.7], [82.4, 17.1], [82.0, 17.1], [82.0, 16.7]]] };
const pt = (lon, lat, props) => ({ type: "Feature", properties: props === undefined ? { species: "Rhizophora mucronata", count: 10, observedAt: "2026-06-01" } : props, geometry: { type: "Point", coordinates: [lon, lat] } });
const fc = (...features) => ({ type: "FeatureCollection", features });
const poly = (ring) => ({ type: "Feature", properties: null, geometry: { type: "Polygon", coordinates: [ring] } });
const v = (doc, opts = { boundary: BOUNDARY }) => geo.validate(typeof doc === "string" || Buffer.isBuffer(doc) ? doc : JSON.stringify(doc), opts);
const codes = (r) => r.errors.map((e) => e.code);
const wcodes = (r) => r.warnings.map((e) => e.code);

test("a valid collection inside the boundary passes and yields an unreviewed species summary", () => {
  const r = v(fc(pt(82.1, 16.8), pt(82.2, 16.9, { species: "Avicennia marina", count: 4 }), pt(82.3, 17.0)));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.deepEqual(r.summary.speciesTotals, { "Rhizophora mucronata": 20, "Avicennia marina": 4 });
  assert.equal(r.summary.featureCount, 3); assert.equal(r.summary.pointCount, 3); assert.deepEqual(r.summary.geometryTypes, { Point: 3 });
  assert.deepEqual(r.summary.bbox, [82.1, 16.8, 82.3, 17]); assert.equal(r.summary.observationDates.first, "2026-06-01");
  assert.equal(r.boundary.status, "INSIDE"); assert.equal(r.boundary.checked, true); assert.equal(r.boundary.insideFraction, 1);
});

test("a single Feature, a bare geometry and a UTF-8 BOM are accepted", () => {
  assert.equal(v(pt(82.1, 16.8)).valid, true);
  assert.equal(v({ type: "Point", coordinates: [82.1, 16.8] }).valid, true);
  assert.equal(v(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(fc(pt(82.1, 16.8))))])).valid, true);
});

test("unreadable input is rejected with a specific code and no summary", () => {
  assert.deepEqual(codes(v("")), ["EMPTY_FILE"]);
  assert.deepEqual(codes(v("{not json")), ["MALFORMED_JSON"]);
  assert.deepEqual(codes(v(Buffer.from([0xff, 0xfe, 0x00, 0x80]))), ["BAD_ENCODING"]);
  assert.deepEqual(codes(v("[1,2,3]")), ["NOT_GEOJSON"]);
  assert.deepEqual(codes(v({ features: [] })), ["NOT_GEOJSON"]);
  assert.deepEqual(codes(v({ type: "Banana" })), ["NOT_GEOJSON"]);
  assert.deepEqual(codes(v({ type: "FeatureCollection" })), ["NOT_GEOJSON", "NO_FEATURES"].slice(0, 1));
  assert.deepEqual(codes(v(fc())), ["NO_FEATURES"]);
  const r = v("{not json"); assert.equal(r.valid, false); assert.equal(r.summary, null);
});

test("size, feature and vertex limits are enforced", () => {
  assert.deepEqual(codes(v(fc(pt(82.1, 16.8)), { boundary: BOUNDARY, limits: { maxBytes: 20 } })), ["TOO_LARGE"]);
  assert.deepEqual(codes(v(fc(pt(82.1, 16.8), pt(82.2, 16.8), pt(82.3, 16.8)), { boundary: BOUNDARY, limits: { maxFeatures: 2 } })), ["TOO_MANY_FEATURES"]);
  assert.deepEqual(codes(v({ type: "LineString", coordinates: Array.from({ length: 50 }, (_, i) => [82.1 + i / 1000, 16.8]) }, { boundary: BOUNDARY, limits: { maxVertices: 10 } })), ["TOO_MANY_VERTICES"]);
  assert.ok(geo.LIMITS.maxBytes >= 1024 * 1024 && geo.LIMITS.maxFeatures > 0);
});

test("coordinates: ranges, shape and order", () => {
  assert.ok(codes(v(pt(82.2, 95))).includes("COORDINATE_OUT_OF_RANGE"));
  assert.ok(codes(v(pt(200, 16.8))).includes("COORDINATE_OUT_OF_RANGE"));
  const badOrder = v(pt(200, 16.8)); assert.match(badOrder.errors[0].message, /\[longitude, latitude\]/);
  const swapped = v(fc(pt(16.8, 82.2), pt(82.1, 16.8))); // a valid pair that is nonetheless in the wrong place for this project
  assert.ok(codes(swapped).includes("POINT_OUTSIDE_BOUNDARY")); assert.match(swapped.errors[0].message, /1 of them would be inside if latitude and longitude were swapped/);
  assert.doesNotMatch(v(fc(pt(70, 10))).errors[0].message, /swapped/, "no hint when swapping would not help");
  assert.ok(codes(v({ type: "Point", coordinates: ["82.1", "16.8"] })).includes("BAD_COORDINATE"));
  assert.ok(codes(v({ type: "Point", coordinates: [82.1] })).includes("BAD_COORDINATE"));
  assert.ok(codes(v({ type: "Point", coordinates: [82.1, 16.8, 0, 5] })).includes("BAD_COORDINATE"));
  assert.equal(v({ type: "Point", coordinates: [82.1, 16.8, 12.5] }).valid, true, "altitude is allowed");
  assert.equal(v({ type: "Point", coordinates: [-180, -90] }, { boundary: null }).valid, true, "range limits are inclusive");
});

test("geometry types and structure", () => {
  assert.ok(codes(v({ type: "Feature", properties: {}, geometry: { type: "GeometryCollection", geometries: [] } })).includes("UNSUPPORTED_GEOMETRY"));
  assert.ok(codes(v({ type: "Feature", properties: {}, geometry: null })).includes("NULL_GEOMETRY"));
  assert.ok(codes(v(fc({ type: "Banana" }))).includes("NOT_A_FEATURE"));
  assert.ok(codes(v({ type: "LineString", coordinates: [[82.1, 16.8]] })).includes("LINE_TOO_SHORT"));
  assert.ok(codes(v(poly([[82.1, 16.8], [82.2, 16.8], [82.1, 16.8]]))).includes("RING_TOO_SHORT"));
  assert.ok(codes(v(poly([[82.1, 16.8], [82.2, 16.8], [82.2, 16.9], [82.15, 16.85]]))).includes("UNCLOSED_RING"));
  assert.ok(codes(v(poly([[82.1, 16.8], [82.2, 16.8], [82.3, 16.8], [82.1, 16.8]]))).includes("ZERO_AREA"));
  const bowtie = v(poly([[82.1, 16.8], [82.3, 16.9], [82.3, 16.8], [82.1, 16.9], [82.1, 16.8]])); assert.deepEqual(codes(bowtie), ["SELF_INTERSECTION"], "a bowtie is reported as self-crossing, not as having no area");
  assert.equal(v(poly([[82.1, 16.8], [82.3, 16.8], [82.3, 16.9], [82.1, 16.9], [82.1, 16.8]])).valid, true, "a simple square is valid");
  assert.equal(v({ type: "MultiPolygon", coordinates: [[[[82.1, 16.8], [82.2, 16.8], [82.2, 16.9], [82.1, 16.9], [82.1, 16.8]]]] }).valid, true);
  assert.ok(codes(v({ type: "MultiPoint", coordinates: [] })).includes("BAD_COORDINATE"));
});

test("coordinate reference system", () => {
  assert.ok(codes(v({ ...fc(pt(82.1, 16.8)), crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::3857" } } })).includes("UNSUPPORTED_CRS"));
  assert.equal(v({ ...fc(pt(82.1, 16.8)), crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } } }).valid, true);
  assert.equal(v({ ...fc(pt(82.1, 16.8)), crs: { type: "name", properties: { name: "EPSG:4326" } } }).valid, true);
  assert.ok(codes(v({ ...fc(pt(82.1, 16.8)), crs: "EPSG:4326" })).includes("UNSUPPORTED_CRS"), "an unreadable crs member is not trusted");
});

test("properties: wrong types are errors; missing species/count is a warning and is left out of the summary", () => {
  assert.ok(codes(v(fc(pt(82.1, 16.8, { species: "A", count: 1.5 })))).includes("BAD_PROPERTY"));
  assert.ok(codes(v(fc(pt(82.1, 16.8, { species: "A", count: -1 })))).includes("BAD_PROPERTY"));
  assert.ok(codes(v(fc(pt(82.1, 16.8, { species: 7, count: 1 })))).includes("BAD_PROPERTY"));
  assert.ok(codes(v(fc(pt(82.1, 16.8, { species: "  ", count: 1 })))).includes("BAD_PROPERTY"));
  assert.ok(codes(v(fc(pt(82.1, 16.8, { species: "A", count: "5" })))).includes("BAD_PROPERTY"));
  assert.ok(codes(v(fc(pt(82.1, 16.8, { species: "A", count: 1, observedAt: "2026-02-30" })))).includes("BAD_PROPERTY"));
  assert.ok(codes(v(fc(pt(82.1, 16.8, { species: "A", count: 1, observedAt: "2999-01-01" })))).includes("BAD_PROPERTY"), "future dates are refused");
  assert.ok(codes(v({ type: "Feature", properties: [1], geometry: { type: "Point", coordinates: [82.1, 16.8] } })).includes("BAD_PROPERTY"));
  const r = v(fc(pt(82.1, 16.8), pt(82.2, 16.8, {}), pt(82.3, 16.8, null)));
  assert.equal(r.valid, true); assert.ok(wcodes(r).includes("MISSING_PROPERTIES")); assert.equal(r.summary.pointsWithoutSpeciesOrCount, 2);
  assert.deepEqual(r.summary.speciesTotals, { "Rhizophora mucronata": 10 }, "incomplete points do not contribute to totals");
  assert.equal(v(fc(pt(82.1, 16.8, { species: "A", count: 0 }))).summary.speciesTotals.A, 0, "zero is a valid count");
});

test("boundary: points must be inside, shapes may overlap partially, fully outside shapes are refused", () => {
  const out = v(fc(pt(82.1, 16.8), pt(83.5, 16.8), pt(82.2, 18.0)));
  assert.equal(out.valid, false); assert.ok(codes(out).includes("POINT_OUTSIDE_BOUNDARY")); assert.equal(out.boundary.pointsOutside, 2); assert.equal(out.boundary.status, "PARTIAL");
  assert.match(out.errors.find((e) => e.code === "POINT_OUTSIDE_BOUNDARY").message, /features\[1\].*features\[2\]/);
  const allOut = v(fc(pt(70, 10))); assert.equal(allOut.boundary.status, "OUTSIDE");
  const partial = v(poly([[82.3, 16.8], [82.6, 16.8], [82.6, 16.9], [82.3, 16.9], [82.3, 16.8]]));
  assert.equal(partial.valid, true, JSON.stringify(partial.errors)); assert.ok(wcodes(partial).includes("PARTIAL_OVERLAP")); assert.equal(partial.boundary.status, "PARTIAL");
  const away = v(poly([[83.0, 16.8], [83.2, 16.8], [83.2, 16.9], [83.0, 16.9], [83.0, 16.8]])); assert.ok(codes(away).includes("OUTSIDE_BOUNDARY"));
  assert.equal(v(fc(pt(82.0, 16.7), pt(82.4, 17.1), pt(82.2, 16.7))).valid, true, "corners and edges count as inside");
});

test("boundary: holes, multipolygons and unusable or missing boundaries", () => {
  const holed = { type: "Polygon", coordinates: [BOUNDARY.coordinates[0], [[82.15, 16.85], [82.25, 16.85], [82.25, 16.95], [82.15, 16.95], [82.15, 16.85]]] };
  assert.ok(codes(v(fc(pt(82.2, 16.9)), { boundary: holed })).includes("POINT_OUTSIDE_BOUNDARY"), "a point in a hole is outside");
  assert.equal(v(fc(pt(82.05, 16.75)), { boundary: holed }).valid, true);
  assert.equal(v(fc(pt(82.15, 16.9)), { boundary: holed }).valid, true, "the edge of a hole is inside the boundary");
  const multi = { type: "MultiPolygon", coordinates: [BOUNDARY.coordinates, [[[84, 18], [84.2, 18], [84.2, 18.2], [84, 18.2], [84, 18]]]] };
  assert.equal(v(fc(pt(84.1, 18.1)), { boundary: multi }).valid, true); assert.ok(codes(v(fc(pt(83, 17)), { boundary: multi })).includes("POINT_OUTSIDE_BOUNDARY"));
  const none = v(fc(pt(50, 50)), { boundary: null });
  assert.equal(none.valid, true, "a file cannot be failed against a boundary that does not exist"); assert.equal(none.boundary.status, "NO_BOUNDARY"); assert.equal(none.boundary.checked, false); assert.match(none.boundary.message, /not validated/);
  for (const bad of [{ type: "Polygon", coordinates: [] }, { type: "Point", coordinates: [1, 2] }, { type: "Polygon", coordinates: [[[1, 2], [3, 4]]] }, "text", { type: "Polygon", coordinates: [[[1, 2], [3, 4], [5, 6], [7, 999], [1, 2]]] }]) {
    const r = v(fc(pt(82.1, 16.8)), { boundary: bad }); assert.equal(r.boundary.status, "BOUNDARY_UNUSABLE"); assert.equal(r.boundary.checked, false); assert.equal(r.valid, true);
  }
});

test("errors are capped so a hostile file cannot produce an unbounded response", () => {
  const r = v(fc(...Array.from({ length: 200 }, () => pt(500, 500))));
  assert.equal(r.valid, false); assert.ok(r.errors.length <= geo.LIMITS.maxErrors + 1); assert.equal(r.errors.at(-1).code, "MORE_ERRORS");
});

test("a large simple ring is validated without hanging, and very large rings are flagged as not self-intersection-checked", () => {
  const n = 1200, ring = Array.from({ length: n }, (_, i) => [82.2 + 0.1 * Math.cos((2 * Math.PI * i) / n), 16.9 + 0.1 * Math.sin((2 * Math.PI * i) / n)]); ring.push(ring[0]);
  const t0 = Date.now(); const r = v(poly(ring)); assert.equal(r.valid, true, JSON.stringify(r.errors)); assert.ok(Date.now() - t0 < 3000);
  const big = Array.from({ length: 1600 }, (_, i) => [82.2 + 0.1 * Math.cos((2 * Math.PI * i) / 1600), 16.9 + 0.1 * Math.sin((2 * Math.PI * i) / 1600)]); big.push(big[0]);
  assert.ok(wcodes(v(poly(big))).includes("SELF_INTERSECTION_NOT_CHECKED"));
});

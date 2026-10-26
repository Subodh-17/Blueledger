// File inspection: facts read from the file itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const storage = require("../src/services/storage");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("inspect(): PNG dimensions, size and absence of embedded capture data", async () => {
  const m = await storage.inspect(PNG, "image/png");
  assert.equal(m.width, 1); assert.equal(m.height, 1); assert.equal(m.sizeBytes, PNG.length);
  assert.equal(m.embeddedCaptureTime, null); assert.equal(m.embeddedLatitude, null);
});

test("inspect(): JPEG dimensions are read from the frame header; missing EXIF is reported as absent, not invented", async () => {
  // SOI, APP0 stub, SOF0 (precision 8, height 480, width 640), EOI
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  const m = await storage.inspect(jpg, "image/jpeg");
  assert.equal(m.width, 640); assert.equal(m.height, 480);
  assert.equal(m.embeddedLatitude, null); assert.equal(m.device, null);
});

test("signatureOk(): signatures for every accepted type", () => {
  const pad = (b) => Buffer.concat([b, Buffer.alloc(16)]);
  assert.ok(storage.signatureOk(pad(Buffer.from([0xff, 0xd8, 0xff])), ".jpg"));
  assert.ok(storage.signatureOk(pad(Buffer.from("%PDF-1.7")), ".pdf"));
  assert.ok(storage.signatureOk(pad(Buffer.from([0x49, 0x49, 0x2a, 0x00])), ".tiff"));
  assert.ok(storage.signatureOk(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(4)]), ".webp"));
  assert.ok(!storage.signatureOk(pad(Buffer.from("GIF89a")), ".png"));
  assert.ok(!storage.signatureOk(Buffer.from("tiny"), ".png"));
});

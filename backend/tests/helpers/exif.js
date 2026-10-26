// Builds a minimal JPEG whose EXIF block carries GPS coordinates and a capture time, so embedded-metadata checks can be tested for real.
function makeExifJpeg({ lat, lon, takenAt = "2026:06:01 10:00:00" }) {
  const rat = (v) => { const d = Math.floor(Math.abs(v)), mf = (Math.abs(v) - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60 * 100); return [d, 1, m, 1, s, 100]; };
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }, u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const entry = (tag, type, count, value) => Buffer.concat([u16(tag), u16(type), u32(count), Buffer.isBuffer(value) ? Buffer.concat([value, Buffer.alloc(4 - value.length)]) : u32(value)]);
  const date = Buffer.from(takenAt + "\0"), latR = Buffer.concat(rat(lat).map(u32)), lonR = Buffer.concat(rat(lon).map(u32));
  const exifOff = 38, gpsOff = 56, dateOff = 110, latOff = 130, lonOff = 154;
  const tiff = Buffer.concat([
    Buffer.from("II*\0"), u32(8),
    u16(2), entry(0x8769, 4, 1, exifOff), entry(0x8825, 4, 1, gpsOff), u32(0),
    u16(1), entry(0x9003, 2, 20, dateOff), u32(0),
    u16(4), entry(1, 2, 2, Buffer.from(lat >= 0 ? "N\0" : "S\0")), entry(2, 5, 3, latOff), entry(3, 2, 2, Buffer.from(lon >= 0 ? "E\0" : "W\0")), entry(4, 5, 3, lonOff), u32(0),
    date, latR, lonR,
  ]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, sof, Buffer.from([0xff, 0xd9])]);
}
module.exports = { makeExifJpeg };

/* Roll Stamp core — dependency-free EXIF reader/writer for JPEG and TIFF.
   JPEG: the Exif APP1 segment is rebuilt (existing tags kept, ours merged in);
         compressed image data is copied byte-for-byte, never re-encoded.
   TIFF: a new IFD0 is appended at the end of the file and the header repointed;
         image strips/tiles are never moved. */
const ExifCore = (() => {
  const TS = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  const SUB = new Set([0x8769, 0x8825, 0xA005]); // Exif, GPS, Interop pointers
  const te = new TextEncoder();
  const td = new TextDecoder();

  // ---------- parsing ----------
  function parseTiff(u8, opts = {}) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 8) throw new Error('EXIF block too short');
    const bo = dv.getUint16(0);
    if (bo !== 0x4949 && bo !== 0x4D4D) throw new Error('Bad TIFF header');
    const le = bo === 0x4949;
    if (dv.getUint16(2, le) !== 42) throw new Error('Unsupported TIFF variant (BigTIFF?)');
    const g16 = o => dv.getUint16(o, le), g32 = o => dv.getUint32(o, le);
    const seen = new Set();
    function readIFD(off, depth) {
      const ifd = new Map();
      ifd.next = 0;
      if (seen.has(off) || off < 8 || off + 2 > u8.length) return ifd;
      seen.add(off);
      const n = g16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > u8.length) break;
        const tag = g16(e), type = g16(e + 2), count = g32(e + 4);
        const sz = TS[type];
        if (!sz) continue;
        if (SUB.has(tag) && depth < 3) { ifd.set(tag, { sub: readIFD(g32(e + 8), depth + 1) }); continue; }
        if (tag === 0x927C && opts.dropMakerNote) continue; // offsets inside would break when moved
        const size = sz * count;
        const raw = u8.slice(e + 8, e + 12);
        const vo = size <= 4 ? e + 8 : g32(e + 8);
        const entry = { type, count, raw };
        if (size <= u8.length && vo + size <= u8.length) entry.bytes = u8.slice(vo, vo + size);
        else if (!opts.keepRaw) continue; // value outside what we read
        ifd.set(tag, entry);
      }
      const nOff = off + 2 + n * 12;
      ifd.next = nOff + 4 <= u8.length ? g32(nOff) : 0;
      return ifd;
    }
    return { le, ifd0: readIFD(g32(4), 0) };
  }

  // ---------- serializing ----------
  function serialize(le, ifd0, base, keepRaw, next0) {
    let buf = new Uint8Array(8192), dv = new DataView(buf.buffer);
    const ensure = n => {
      if (n <= buf.length) return;
      const nb = new Uint8Array(Math.max(n, buf.length * 2)); nb.set(buf); buf = nb; dv = new DataView(buf.buffer);
    };
    const s16 = (o, v) => dv.setUint16(o, v, le), s32 = (o, v) => dv.setUint32(o, v, le);
    function writeIFD(ifd, pos, nextVal) {
      const tags = [...ifd.keys()].sort((a, b) => a - b);
      const n = tags.length;
      let data = pos + 2 + n * 12 + 4;
      ensure(data);
      s16(pos, n);
      const subs = [];
      tags.forEach((tag, i) => {
        const e = pos + 2 + i * 12, v = ifd.get(tag);
        s16(e, tag);
        if (v.sub) { s16(e + 2, 4); s32(e + 4, 1); subs.push([e, v.sub]); return; }
        s16(e + 2, v.type); s32(e + 4, v.count);
        if (keepRaw && v.raw) { buf.set(v.raw, e + 8); return; }
        const b = v.bytes;
        if (b.length <= 4) { buf.set(b, e + 8); return; }
        if (data & 1) data++;
        ensure(data + b.length);
        buf.set(b, data);
        s32(e + 8, base + data);
        data += b.length;
      });
      s32(pos + 2 + n * 12, nextVal || 0);
      for (const [e, sub] of subs) {
        if (data & 1) data++;
        s32(e + 8, base + data);
        data = writeIFD(sub, data, 0);
      }
      return data;
    }
    const len = writeIFD(ifd0, 0, next0 || 0);
    return buf.slice(0, len);
  }

  // ---------- value encoders ----------
  function enc(le) {
    const mk = (type, count, bytes) => ({ type, count, bytes });
    return {
      ascii(s) { const b = te.encode(s); const o = new Uint8Array(b.length + 1); o.set(b); return mk(2, o.length, o); },
      short(arr) { const o = new Uint8Array(arr.length * 2), d = new DataView(o.buffer); arr.forEach((v, i) => d.setUint16(i * 2, v, le)); return mk(3, arr.length, o); },
      rational(arr) { const o = new Uint8Array(arr.length * 8), d = new DataView(o.buffer); arr.forEach(([n, m], i) => { d.setUint32(i * 8, n, le); d.setUint32(i * 8 + 4, m, le); }); return mk(5, arr.length, o); },
      undef(bytes) { const o = Uint8Array.from(bytes); return mk(7, o.length, o); },
      userComment(s) {
        if (/^[\x00-\x7f]*$/.test(s)) {
          const b = te.encode(s), o = new Uint8Array(8 + b.length);
          o.set(te.encode('ASCII\0\0\0')); o.set(b, 8); return mk(7, o.length, o);
        }
        const o = new Uint8Array(8 + s.length * 2), d = new DataView(o.buffer);
        o.set(te.encode('UNICODE\0'));
        for (let i = 0; i < s.length; i++) d.setUint16(8 + i * 2, s.charCodeAt(i), le);
        return mk(7, o.length, o);
      },
    };
  }
  function toRational(x) {
    if (!isFinite(x) || x <= 0) return null;
    let d = 1;
    while (Math.abs(x * d - Math.round(x * d)) > 1e-6 && d < 10000) d *= 10;
    return [Math.round(x * d), d];
  }

  // ---------- applying edits ----------
  // Empty / null fields leave whatever the file already has.
  function applyEdits(t, ed) {
    const E = enc(t.le), ifd0 = t.ifd0;
    let exif = ifd0.get(0x8769) && ifd0.get(0x8769).sub;
    if (!exif) { exif = new Map(); ifd0.set(0x8769, { sub: exif }); }
    exif.set(0x9000, E.undef(te.encode('0232')));            // ExifVersion
    exif.set(0xA300, E.undef([1]));                           // FileSource = film scanner
    const A = (ifd, tag, v) => { if (v) ifd.set(tag, E.ascii(String(v))); };

    if (ed.dateTime) {
      A(ifd0, 0x0132, ed.dateTime);                           // DateTime
      A(exif, 0x9003, ed.dateTime);                           // DateTimeOriginal
      exif.delete(0x9291);                                    // SubSecTimeOriginal
      if (ed.offset) { A(exif, 0x9010, ed.offset); A(exif, 0x9011, ed.offset); }
      if (ed.setDigitized) {
        A(exif, 0x9004, ed.dateTime); exif.delete(0x9292);
        if (ed.offset) A(exif, 0x9012, ed.offset);
      }
    }
    A(ifd0, 0x010F, ed.make);                                 // Make
    A(ifd0, 0x0110, ed.model);                                // Model
    A(exif, 0xA433, ed.lensMake);                             // LensMake
    A(exif, 0xA434, ed.lensModel);                            // LensModel
    if (ed.focal) exif.set(0x920A, E.rational([toRational(ed.focal)]));        // FocalLength
    if (ed.focal35) exif.set(0xA405, E.short([Math.min(65535, Math.round(ed.focal35))]));
    if (ed.fnumber) exif.set(0x829D, E.rational([toRational(ed.fnumber)]));    // FNumber
    if (ed.iso) exif.set(0x8827, E.short([Math.min(65535, Math.round(ed.iso))])); // ISO
    if (ed.film) {
      exif.set(0x9286, E.userComment(ed.film));               // UserComment
      if (ed.filmInDescription) A(ifd0, 0x010E, ed.film);     // ImageDescription
    }
    A(ifd0, 0x013B, ed.artist);
    A(ifd0, 0x8298, ed.copyright);
    if (ed.stripXmp) ifd0.delete(0x02BC);
  }

  // ---------- JPEG ----------
  function scanJpeg(u8) {
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) throw new Error('Not a JPEG');
    let p = 2; const segs = [];
    while (p + 4 <= u8.length) {
      if (u8[p] !== 0xFF) throw new Error('Corrupt JPEG structure');
      const m = u8[p + 1];
      if (m === 0xFF) { p++; continue; }
      if (m === 0xDA || m === 0xD9) return { segs, sos: p };
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { p += 2; continue; }
      const len = (u8[p + 2] << 8) | u8[p + 3];
      if (p + 2 + len > u8.length) return { segs, sos: -1 };
      segs.push({ m, start: p, end: p + 2 + len });
      p += 2 + len;
    }
    return { segs, sos: -1 };
  }
  const startsWith = (u8, at, str) => { for (let i = 0; i < str.length; i++) if (u8[at + i] !== str.charCodeAt(i)) return false; return true; };
  const isExifSeg = (u8, s) => s.m === 0xE1 && startsWith(u8, s.start + 4, 'Exif\0\0');
  const isXmpSeg = (u8, s) => s.m === 0xE1 && (startsWith(u8, s.start + 4, 'http://ns.adobe.com/xap/1.0/\0') || startsWith(u8, s.start + 4, 'http://ns.adobe.com/xmp/extension/\0'));

  async function readHead(file) {
    let u8 = new Uint8Array(await file.slice(0, Math.min(file.size, 2 << 20)).arrayBuffer());
    let sc = scanJpeg(u8);
    if (sc.sos < 0 && u8.length < file.size) { u8 = new Uint8Array(await file.arrayBuffer()); sc = scanJpeg(u8); }
    if (sc.sos < 0) throw new Error('Could not find image data in JPEG');
    return { u8, ...sc };
  }

  async function processJpeg(file, ed) {
    const { u8, segs, sos } = await readHead(file);
    const ex = segs.find(s => isExifSeg(u8, s));
    let t = null;
    if (ex) { try { t = parseTiff(u8.subarray(ex.start + 10, ex.end), { dropMakerNote: true }); } catch (e) { t = null; } }
    if (!t) t = { le: true, ifd0: new Map() };
    applyEdits(t, ed);
    const body = serialize(t.le, t.ifd0, 8, false, 0);
    const hdr = t.le ? [0x49, 0x49, 42, 0, 8, 0, 0, 0] : [0x4D, 0x4D, 0, 42, 0, 0, 0, 8];
    const segLen = 2 + 6 + 8 + body.length;
    if (segLen > 0xFFFF) throw new Error('EXIF data too large for a JPEG segment');
    const app1 = new Uint8Array(2 + segLen);
    app1.set([0xFF, 0xE1, segLen >> 8, segLen & 255]); app1.set(te.encode('Exif\0\0'), 4); app1.set(hdr, 10); app1.set(body, 18);

    const parts = [new Uint8Array([0xFF, 0xD8])];
    let inserted = false;
    for (const s of segs) {
      if (s === ex) { parts.push(app1); inserted = true; continue; }
      if (ed.stripXmp && isXmpSeg(u8, s)) continue;
      if (!inserted && !ex && s.m !== 0xE0) { parts.push(app1); inserted = true; }
      parts.push(u8.subarray(s.start, s.end));
    }
    if (!inserted) parts.push(app1);
    parts.push(file.slice(sos));
    return new Blob(parts, { type: 'image/jpeg' });
  }

  // ---------- TIFF ----------
  async function processTiff(file, ed) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const t = parseTiff(u8, { keepRaw: true });
    const next0 = t.ifd0.next;
    applyEdits(t, ed);
    const pad = u8.length & 1, base = u8.length + pad;
    const body = serialize(t.le, t.ifd0, base, true, next0);
    if (base + body.length > 0xFFFFFFFF) throw new Error('TIFF would exceed 4 GB');
    const hdr = u8.slice(0, 8);
    new DataView(hdr.buffer).setUint32(4, base, t.le);
    return new Blob([hdr, u8.subarray(8), new Uint8Array(pad), body], { type: 'image/tiff' });
  }

  // ---------- reading info for the preview ----------
  const ascii = e => e && e.bytes ? td.decode(e.bytes).replace(/\0[\s\S]*$/, '').trim() : '';
  function infoFrom(t, hasXmp) {
    const exif = t.ifd0.get(0x8769) && t.ifd0.get(0x8769).sub || new Map();
    return {
      date: ascii(exif.get(0x9003)) || ascii(t.ifd0.get(0x0132)),
      make: ascii(t.ifd0.get(0x010F)),
      model: ascii(t.ifd0.get(0x0110)),
      hasXmp: hasXmp || t.ifd0.has(0x02BC),
    };
  }
  function readInfo(u8, kind) {
    if (kind === 'jpeg') {
      const { segs } = scanJpeg(u8);
      const ex = segs.find(s => isExifSeg(u8, s));
      const hasXmp = segs.some(s => isXmpSeg(u8, s));
      if (!ex) return { date: '', make: '', model: '', hasXmp };
      return infoFrom(parseTiff(u8.subarray(ex.start + 10, ex.end)), hasXmp);
    }
    return infoFrom(parseTiff(u8, { keepRaw: true }), false);
  }

  // ---------- minimal ZIP (stored, no compression) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  class Zip {
    constructor() { this.parts = []; this.central = []; this.offset = 0; this.count = 0; }
    async add(name, blob) {
      const data = new Uint8Array(await blob.arrayBuffer());
      const crc = crc32(data), nm = te.encode(name), now = new Date();
      const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      if (this.offset + 30 + nm.length + data.length > 0xFFFFFFFF) throw new Error('ZIP would exceed 4 GB');
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true);
      ch.setUint32(42, this.offset, true);
      this.parts.push(lh.buffer, nm, data);
      this.central.push(ch.buffer, nm);
      this.offset += 30 + nm.length + data.length;
      this.count++;
    }
    finish() {
      const cdSize = this.central.reduce((a, b) => a + b.byteLength, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, this.count, true); end.setUint16(10, this.count, true);
      end.setUint32(12, cdSize, true); end.setUint32(16, this.offset, true);
      return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
    }
  }

  return { parseTiff, processJpeg, processTiff, readInfo, Zip, crc32 };
})();
if (typeof module !== 'undefined') module.exports = ExifCore;

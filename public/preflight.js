// Preflight voor drukwerk, helemaal in de browser: kleurruimtes (RGB/CMYK/steunkleur),
// output intent (kleurprofiel), effectieve resolutie van beelden op 100% plaatsing,
// ingesloten lettertypes en afloop. Leest de PDF met pdf-lib en loopt zelf de
// content streams door om te zien waar en hoe groot elk beeld geplaatst is.
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFNumber, PDFString, PDFHexString, decodePDFRawStream } from './vendor/pdf-lib.esm.min.js';

const PT_TO_MM = 25.4 / 72;
export const PPI_GOOD = 300;
export const PPI_MIN = 200;
const PROCESS_NAMES = new Set(['Cyan', 'Magenta', 'Yellow', 'Black']);

export async function preflight(data, onProgress) {
  const doc = await PDFDocument.load(data, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
  const ctx = doc.context;
  const look = (x) => (x == null ? undefined : ctx.lookup(x));
  const dictGet = (dict, key) => (dict instanceof PDFDict ? look(dict.get(PDFName.of(key))) : undefined);
  const nameOf = (x) => (x instanceof PDFName ? x.decodeText() : null);
  const num = (x) => (x instanceof PDFNumber ? x.asNumber() : null);
  const text = (x) => (x instanceof PDFString || x instanceof PDFHexString ? x.decodeText() : null);
  const bytesOf = (stream) => {
    try {
      if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
      if (stream && typeof stream.getContents === 'function') return stream.getContents();
    } catch {}
    return null;
  };

  // ---- Kleurruimte van een object ----
  function colorSpace(cs, resources, depth = 0) {
    cs = look(cs);
    if (depth > 6 || cs == null) return { kind: 'Onbekend' };
    const n = nameOf(cs);
    if (n) {
      if (n === 'DeviceRGB' || n === 'RGB') return { kind: 'RGB' };
      if (n === 'DeviceCMYK' || n === 'CMYK') return { kind: 'CMYK' };
      if (n === 'DeviceGray' || n === 'G') return { kind: 'Grijs' };
      if (n === 'Pattern') return { kind: 'Patroon' };
      if (n === 'I' || n === 'Indexed') return { kind: 'Onbekend' };
      const res = dictGet(dictGet(resources, 'ColorSpace'), n);
      return res ? colorSpace(res, resources, depth + 1) : { kind: 'Onbekend' };
    }
    if (cs instanceof PDFArray) {
      const family = nameOf(look(cs.get(0)));
      if (family === 'ICCBased') {
        const comps = num(dictGet(look(cs.get(1)).dict, 'N'));
        return { kind: comps === 4 ? 'CMYK' : comps === 1 ? 'Grijs' : 'RGB', icc: true };
      }
      if (family === 'CalRGB') return { kind: 'RGB' };
      if (family === 'CalGray') return { kind: 'Grijs' };
      if (family === 'Lab') return { kind: 'Lab' };
      if (family === 'Indexed' || family === 'I') return colorSpace(cs.get(1), resources, depth + 1);
      if (family === 'Pattern') return { kind: 'Patroon' };
      if (family === 'Separation') {
        const name = nameOf(look(cs.get(1)));
        if (name === 'All' || name === 'None') return { kind: 'CMYK' };
        if (PROCESS_NAMES.has(name)) return { kind: 'CMYK' };
        return { kind: 'Steunkleur', spots: [name] };
      }
      if (family === 'DeviceN') {
        const names = (look(cs.get(1))?.asArray?.() || []).map((x) => nameOf(look(x))).filter(Boolean);
        const spots = names.filter((x) => !PROCESS_NAMES.has(x) && x !== 'None');
        return spots.length ? { kind: 'Steunkleur', spots } : { kind: 'CMYK' };
      }
    }
    return { kind: 'Onbekend' };
  }

  // ---- Lettertypes ----
  const fontCache = new Map();
  function fontInfo(fontRef) {
    const key = fontRef?.toString?.() || String(Math.random());
    if (fontCache.has(key)) return fontCache.get(key);
    const font = look(fontRef);
    let name = nameOf(dictGet(font, 'BaseFont')) || 'Naamloos';
    name = name.replace(/^[A-Z]{6}\+/, '');
    const sub = nameOf(dictGet(font, 'Subtype'));
    let desc = dictGet(font, 'FontDescriptor');
    if (sub === 'Type0') {
      const desc0 = look(dictGet(font, 'DescendantFonts')?.get?.(0));
      desc = dictGet(desc0, 'FontDescriptor');
    }
    const embedded = sub === 'Type3' || !!(desc && (dictGet(desc, 'FontFile') || dictGet(desc, 'FontFile2') || dictGet(desc, 'FontFile3')));
    const info = { name, embedded };
    fontCache.set(key, info);
    return info;
  }

  // ---- Content stream doorlopen ----
  const mul = (m, c) => [
    m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3],
    m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5],
  ];

  function* tokens(b) {
    const n = b.length;
    let i = 0;
    const ws = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
    const delim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
    while (i < n) {
      const c = b[i];
      if (ws(c)) { i++; continue; }
      if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
      if (c === 40) { // (string)
        let depth = 1; i++;
        while (i < n && depth) { if (b[i] === 92) i += 2; else { if (b[i] === 40) depth++; else if (b[i] === 41) depth--; i++; } }
        yield { t: 'str' }; continue;
      }
      if (c === 60 && b[i + 1] === 60) { i += 2; yield { t: '<<' }; continue; }
      if (c === 62 && b[i + 1] === 62) { i += 2; yield { t: '>>' }; continue; }
      if (c === 60) { while (i < n && b[i] !== 62) i++; i++; yield { t: 'str' }; continue; }
      if (c === 91 || c === 93 || c === 123 || c === 125) { i++; yield { t: String.fromCharCode(c) }; continue; }
      if (c === 47) {
        let j = i + 1;
        while (j < n && !ws(b[j]) && !delim(b[j])) j++;
        yield { t: 'name', v: String.fromCharCode(...b.subarray(i + 1, j)).replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) };
        i = j; continue;
      }
      let j = i;
      while (j < n && !ws(b[j]) && !delim(b[j])) j++;
      if (j === i) { i++; continue; }
      const word = String.fromCharCode(...b.subarray(i, j));
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { yield { t: 'num', v: parseFloat(word) }; continue; }
      if (word === 'ID') {
        // Inline beelddata overslaan tot "EI".
        i++;
        while (i < n && !(b[i] === 69 && b[i + 1] === 73 && ws(b[i - 1]) && (i + 2 >= n || ws(b[i + 2])))) i++;
        i += 2;
        yield { t: 'op', v: 'EI' };
        continue;
      }
      yield { t: 'op', v: word };
    }
  }

  function walk(bytes, resources, ctm0, out, depth) {
    if (!bytes || depth > 10) return;
    let ctm = ctm0;
    const stack = [];
    let ops = [];
    let fillCs = { kind: 'Grijs' }, strokeCs = { kind: 'Grijs' };
    let inlineDict = null;
    for (const tok of tokens(bytes)) {
      if (tok.t !== 'op') { ops.push(tok); if (ops.length > 64) ops.shift(); continue; }
      const op = tok.v;
      const nums = () => ops.filter((x) => x.t === 'num').map((x) => x.v);
      const lastName = () => [...ops].reverse().find((x) => x.t === 'name')?.v;
      switch (op) {
        case 'q': stack.push(ctm); break;
        case 'Q': if (stack.length) ctm = stack.pop(); break;
        case 'cm': { const v = nums().slice(-6); if (v.length === 6) ctm = mul(v, ctm); break; }
        case 'rg': case 'RG': out.colors.add('RGB'); break;
        case 'k': case 'K': out.colors.add('CMYK'); break;
        case 'g': case 'G': out.colors.add('Grijs'); break;
        case 'cs': fillCs = colorSpace(PDFName.of(lastName() || 'DeviceGray'), resources); break;
        case 'CS': strokeCs = colorSpace(PDFName.of(lastName() || 'DeviceGray'), resources); break;
        case 'sc': case 'scn': addCs(out, fillCs); break;
        case 'SC': case 'SCN': addCs(out, strokeCs); break;
        case 'sh': {
          const sh = dictGet(dictGet(resources, 'Shading'), lastName() || '');
          const shDict = sh instanceof PDFDict ? sh : sh?.dict;
          if (shDict) addCs(out, colorSpace(shDict.get(PDFName.of('ColorSpace')), resources));
          break;
        }
        case 'Tf': {
          const ref = dictGet(resources, 'Font')?.get(PDFName.of(lastName() || ''));
          if (ref) { const f = fontInfo(ref); out.fonts.set(f.name, f); }
          break;
        }
        case 'BI': inlineDict = {}; break;
        case 'EI': {
          // Inline beeld: sleutels en waarden staan als tokens tussen BI en ID.
          const pairs = ops;
          const get = (k1, k2) => { const idx = pairs.findIndex((x) => x.t === 'name' && (x.v === k1 || x.v === k2)); return idx >= 0 ? pairs[idx + 1] : null; };
          const w = get('W', 'Width')?.v, h = get('H', 'Height')?.v;
          const csTok = get('CS', 'ColorSpace');
          const isMask = get('IM', 'ImageMask')?.v === 'true';
          if (w && h && !isMask) addImage(out, { w, h, cs: csTok?.t === 'name' ? colorSpace(PDFName.of(csTok.v), resources) : { kind: 'Onbekend' }, inline: true }, ctm);
          inlineDict = null;
          break;
        }
        case 'Do': {
          const name = lastName();
          const xobjects = dictGet(resources, 'XObject');
          const xo = xobjects && look(xobjects.get(PDFName.of(name || '')));
          if (!xo?.dict) break;
          const sub = nameOf(look(xo.dict.get(PDFName.of('Subtype'))));
          if (sub === 'Image') {
            const d = xo.dict;
            const isMask = look(d.get(PDFName.of('ImageMask')))?.toString?.() === 'true';
            if (!isMask) {
              const filter = look(d.get(PDFName.of('Filter')));
              const filters = filter instanceof PDFArray ? filter.asArray().map((x) => nameOf(look(x))) : [nameOf(filter)].filter(Boolean);
              const cs = filters.includes('JPXDecode') && !d.get(PDFName.of('ColorSpace')) ? { kind: 'Onbekend' } : colorSpace(d.get(PDFName.of('ColorSpace')), resources);
              addImage(out, { name, w: num(look(d.get(PDFName.of('Width')))), h: num(look(d.get(PDFName.of('Height')))), cs, filters }, ctm);
            }
          } else if (sub === 'Form') {
            const m = look(xo.dict.get(PDFName.of('Matrix')));
            const mat = m instanceof PDFArray ? m.asArray().map((x) => num(look(x)) ?? 0) : [1, 0, 0, 1, 0, 0];
            const res = look(xo.dict.get(PDFName.of('Resources'))) || resources;
            if (out.forms++ < 2000) walk(bytesOf(xo), res, mul(mat, ctm), out, depth + 1);
          }
          break;
        }
      }
      if (op !== 'BI' && !(inlineDict && op !== 'EI')) ops = [];
    }
  }

  function addCs(out, cs) {
    if (!cs || cs.kind === 'Patroon' || cs.kind === 'Onbekend') return;
    out.colors.add(cs.kind);
    for (const s of cs.spots || []) out.spots.add(s);
  }

  function addImage(out, img, ctm) {
    const wPt = Math.hypot(ctm[0], ctm[1]), hPt = Math.hypot(ctm[2], ctm[3]);
    if (!img.w || !img.h || wPt < 1 || hPt < 1) return;
    const ppi = Math.round(Math.min(img.w / (wPt / 72), img.h / (hPt / 72)));
    addCs(out, img.cs);
    out.images.push({ ...img, cs: img.cs.kind + (img.cs.icc ? ' (ICC)' : ''), csKind: img.cs.kind, wMm: wPt * PT_TO_MM, hMm: hPt * PT_TO_MM, ppi });
  }

  // ---- Output intent / kleurprofiel ----
  function iccInfo(stream) {
    const b = bytesOf(stream);
    if (!b || b.length < 132) return {};
    const str = (o, l) => String.fromCharCode(...b.subarray(o, o + l));
    const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const space = str(16, 4).trim();
    let description = null;
    const count = u32(128);
    for (let k = 0; k < Math.min(count, 100); k++) {
      const e = 132 + k * 12;
      if (str(e, 4) !== 'desc') continue;
      const off = u32(e + 4);
      const type = str(off, 4);
      if (type === 'desc') description = str(off + 12, Math.max(0, u32(off + 8) - 1));
      else if (type === 'mluc') {
        const len = u32(off + 20), so = u32(off + 24);
        let s = '';
        for (let p = 0; p + 1 < len; p += 2) s += String.fromCharCode((b[off + so + p] << 8) | b[off + so + p + 1]);
        description = s;
      }
    }
    return { space: space === 'GRAY' ? 'Grijs' : space, description };
  }

  const intents = [];
  const oi = dictGet(doc.catalog, 'OutputIntents');
  if (oi instanceof PDFArray) {
    for (const x of oi.asArray()) {
      const d = look(x);
      if (!(d instanceof PDFDict)) continue;
      const profile = dictGet(d, 'DestOutputProfile');
      intents.push({
        type: nameOf(dictGet(d, 'S')),
        id: text(dictGet(d, 'OutputConditionIdentifier')),
        info: text(dictGet(d, 'Info')) || text(dictGet(d, 'OutputCondition')),
        ...(profile ? iccInfo(profile) : {}),
      });
    }
  }
  const infoDict = look(ctx.trailerInfo.Info);
  const pdfx = text(dictGet(infoDict, 'GTS_PDFXVersion')) || nameOf(dictGet(infoDict, 'GTS_PDFXVersion'));
  const producer = text(dictGet(infoDict, 'Producer'));

  // ---- Pagina's ----
  const pages = [];
  const all = doc.getPages();
  for (let p = 0; p < all.length; p++) {
    const page = all[p];
    const out = { num: p + 1, colors: new Set(), spots: new Set(), images: [], fonts: new Map(), forms: 0 };
    const contents = look(page.node.get(PDFName.of('Contents')));
    const streams = contents instanceof PDFArray ? contents.asArray().map(look) : [contents];
    const parts = streams.map(bytesOf).filter(Boolean);
    const total = parts.reduce((a, x) => a + x.length + 1, 0);
    const joined = new Uint8Array(total);
    let o = 0;
    for (const x of parts) { joined.set(x, o); o += x.length; joined[o++] = 10; }
    const resources = page.node.Resources();
    try {
      walk(joined, resources, [1, 0, 0, 1, 0, 0], out, 0);
    } catch (e) {
      out.error = String(e.message || e);
    }
    const trim = page.getTrimBox(), bleed = page.getBleedBox();
    const hasTrim = !!page.node.get(PDFName.of('TrimBox'));
    const bleedMm = hasTrim ? Math.min(trim.x - bleed.x, trim.y - bleed.y, bleed.x + bleed.width - trim.x - trim.width, bleed.y + bleed.height - trim.y - trim.height) * PT_TO_MM : 0;
    pages.push({
      num: out.num,
      colors: [...out.colors],
      spots: [...out.spots],
      images: out.images,
      fonts: [...out.fonts.values()],
      hasTrim,
      bleedMm: Math.max(0, Math.round(bleedMm * 10) / 10),
      sizeMm: { w: Math.round(trim.width * PT_TO_MM * 10) / 10, h: Math.round(trim.height * PT_TO_MM * 10) / 10 },
      error: out.error,
    });
    if (onProgress) onProgress((p + 1) / all.length);
    if (p % 4 === 3) await new Promise((r) => setTimeout(r));
  }
  return summarize({ pages, intents, pdfx, producer });
}

function summarize(r) {
  const images = r.pages.flatMap((p) => p.images.map((img) => ({ ...img, page: p.num })))
    // Piepkleine beeldjes (randjes, pixels) tellen niet mee voor de resolutie.
    .filter((img) => img.wMm >= 5 && img.hMm >= 5);
  const low = images.filter((i) => i.ppi < PPI_GOOD).sort((a, b) => a.ppi - b.ppi);
  const rgbPages = r.pages.filter((p) => p.colors.includes('RGB') || p.colors.includes('Lab')).map((p) => p.num);
  const rgbImages = images.filter((i) => i.csKind === 'RGB' || i.csKind === 'Lab');
  const spots = [...new Set(r.pages.flatMap((p) => p.spots))];
  const fonts = new Map();
  r.pages.forEach((p) => p.fonts.forEach((f) => { if (!fonts.has(f.name)) fonts.set(f.name, { ...f, pages: [] }); fonts.get(f.name).pages.push(p.num); }));
  const notEmbedded = [...fonts.values()].filter((f) => !f.embedded);
  const noBleed = r.pages.filter((p) => p.bleedMm < 2.9).map((p) => p.num);
  const sizes = [...new Set(r.pages.map((p) => `${p.sizeMm.w}×${p.sizeMm.h}`))];
  return {
    ...r, images, low, rgbPages, rgbImages, spots, fonts: [...fonts.values()], notEmbedded, noBleed, sizes,
    minPpi: images.length ? Math.min(...images.map((i) => i.ppi)) : null,
  };
}

// Naam van het kleurprofiel (output intent) van een met pdf-lib geladen PDF; '' als er geen is.
export function colorProfileOf(doc) {
  try {
    const oi = doc.context.lookup(doc.catalog.get(PDFName.of('OutputIntents')));
    if (!(oi instanceof PDFArray) || !oi.size()) return '';
    const d = doc.context.lookup(oi.get(0));
    for (const key of ['OutputConditionIdentifier', 'Info', 'OutputCondition']) {
      const v = d instanceof PDFDict ? doc.context.lookup(d.get(PDFName.of(key))) : null;
      const t = v instanceof PDFString || v instanceof PDFHexString ? v.decodeText().trim() : '';
      if (t) return t;
    }
    return 'Output intent zonder naam';
  } catch {
    return '';
  }
}

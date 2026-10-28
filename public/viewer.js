// Bladerboek-viewer: rendert een PDF als boek met realistische pageturn (StPageFlip),
// tekent papierblok, kaft en rug passend bij uitvoering en paginatal, en beheert opmerkingen.
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const PT_TO_MM = 25.4 / 72;

// Fysieke eigenschappen per uitvoering (mm). Papier per vel, kaft per zijde.
const BINDINGS = {
  hardcover: { label: 'Hardcover', paperMm: 0.11, coverMm: 2.4, overhangMm: 3, glossy: false },
  softcover: { label: 'Softcover', paperMm: 0.10, coverMm: 0.35, overhangMm: 0, glossy: false },
  magazine: { label: 'Magazine', paperMm: 0.075, coverMm: 0.12, overhangMm: 0, glossy: true },
};

const state = {
  mode: 'local', // 'server' (deellink) of 'local' (zelf een PDF openen)
  bookId: null,
  meta: { title: 'Bladerboek', binding: 'hardcover', coverMode: 'outer', coverColor: 'auto', allowDownload: true, allowComments: true, allowBindingSwitch: true },
  pdf: null,
  pdfPageCount: 0,
  pageMm: { w: 210, h: 297 },
  trimInset: null, // { left, top, right, bottom } in pt t.o.v. de zichtbare pagina
  aspect: 210 / 297,
  coverColor: '#2b3a55',
  pages: [], // beschrijving van elke bladerpagina
  innerCount: 0,
  images: new Map(), // pdf-paginanummer -> blob-URL
  queue: new Set(),
  rendering: false,
  renderHeight: 1600,
  flip: null,
  landscape: true,
  pw: 0,
  ph: 0,
  flipState: 'read',
  comments: [],
  filter: 'spread',
  pinMode: false,
  pending: null,
  activeComment: null,
  downloadUrl: null,
  localKey: null,
};

// ---------- Start ----------
init();

async function init() {
  setupUi();
  const m = location.pathname.match(/\/b\/([a-z0-9]{10,32})/);
  if (m) {
    state.mode = 'server';
    state.bookId = m[1];
    try {
      const res = await fetch(`/api/books/${state.bookId}`);
      if (!res.ok) throw new Error('Boek niet gevonden');
      Object.assign(state.meta, await res.json());
    } catch (e) {
      return showError('Dit boek kon niet worden geladen.');
    }
    state.downloadUrl = `/api/books/${state.bookId}/pdf?download=1`;
    await openPdf({ url: `/api/books/${state.bookId}/pdf` });
  } else {
    $('dropzone').hidden = false;
    const url = new URLSearchParams(location.search).get('pdf');
    if (url) {
      $('dropzone').hidden = true;
      state.downloadUrl = url;
      await openPdf({ url });
    }
  }
}

function showError(msg) {
  $('loading').hidden = false;
  $('loading').querySelector('.spinner').hidden = true;
  $('loadingText').textContent = msg;
}

async function openLocalFile(file) {
  if (!file || !/pdf$/i.test(file.type || file.name)) return toast('Kies een PDF-bestand');
  $('dropzone').hidden = true;
  const data = new Uint8Array(await file.arrayBuffer());
  state.meta.title = file.name.replace(/\.pdf$/i, '');
  state.meta.coverMode = $('coverModeSelect').value;
  if (state.downloadUrl && state.downloadUrl.startsWith('blob:')) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
  state.downloadName = file.name;
  state.localKey = `bladerboek:${file.name}:${file.size}`;
  state.trimInset = await readTrimLocal(data.slice());
  await openPdf({ data });
}

// TrimBox lezen (snijlijn zonder afloop). Bij een deellink doet de server dit al.
async function readTrimLocal(data) {
  try {
    const { PDFDocument } = await import('./vendor/pdf-lib.esm.min.js');
    const doc = await PDFDocument.load(data, { updateMetadata: false, ignoreEncryption: true });
    const p = doc.getPage(0);
    const crop = p.getCropBox(), trim = p.getTrimBox();
    return insetFrom(crop, trim);
  } catch {
    return null;
  }
}
function insetFrom(crop, trim) {
  const left = trim.x - crop.x, bottom = trim.y - crop.y;
  const right = crop.x + crop.width - (trim.x + trim.width), top = crop.y + crop.height - (trim.y + trim.height);
  const ok = [left, right, top, bottom].every((v) => v >= 0 && v < Math.min(crop.width, crop.height) / 4);
  return ok && left + right + top + bottom > 0.5 ? { left, top, right, bottom } : null;
}

async function openPdf(src) {
  $('loading').hidden = false;
  setLoading('PDF wordt geopend…', 0.05);
  try {
    if (state.pdf) await state.pdf.destroy();
    state.images.forEach((u) => URL.revokeObjectURL(u));
    state.images.clear();
    state.pdf = await pdfjsLib.getDocument({ ...src, isEvalSupported: false }).promise;
  } catch (e) {
    console.error(e);
    return showError('Deze PDF kon niet worden geopend.');
  }
  state.pdfPageCount = state.pdf.numPages;
  if (state.mode === 'server' && state.meta.trim) state.trimInset = state.meta.trim;

  const first = await state.pdf.getPage(1);
  const [x0, y0, x1, y1] = first.view;
  const t = state.trimInset || { left: 0, top: 0, right: 0, bottom: 0 };
  let wPt = x1 - x0 - t.left - t.right, hPt = y1 - y0 - t.top - t.bottom;
  if (first.rotate % 180) [wPt, hPt] = [hPt, wPt];
  state.pageMm = { w: wPt * PT_TO_MM, h: hPt * PT_TO_MM };
  state.aspect = wPt / hPt;
  state.renderHeight = Math.round(Math.min(2200, Math.max(1000, window.innerHeight * (window.devicePixelRatio || 1) * 1.1)));

  document.title = state.meta.title || 'Bladerboek';
  if (state.meta.coverColor && state.meta.coverColor !== 'auto') state.coverColor = state.meta.coverColor;

  await loadComments();
  setLoading('Pagina\'s worden voorbereid…', 0.3);

  // Eerst de omslag en de eerste pagina's renderen, de rest volgt op de achtergrond.
  state.binding = state.meta.binding in BINDINGS ? state.meta.binding : 'hardcover';
  buildPageList();
  const firstPdfPages = state.pages.slice(0, 5).filter((p) => p.pdfPage).map((p) => p.pdfPage);
  for (let i = 0; i < firstPdfPages.length; i++) {
    await renderPdfPage(firstPdfPages[i]);
    setLoading('Pagina\'s worden voorbereid…', 0.3 + (0.6 * (i + 1)) / firstPdfPages.length);
  }
  if ((!state.meta.coverColor || state.meta.coverColor === 'auto') && state.pages[0].pdfPage) {
    state.coverColor = await sampleCoverColor(state.images.get(state.pages[0].pdfPage));
  }
  $('loading').hidden = true;
  $('navbar').hidden = false;
  $('sidePrev').hidden = $('sideNext').hidden = false;
  $('commentsBtn').hidden = !state.meta.allowComments;
  $('downloadBtn').hidden = !(state.meta.allowDownload && state.downloadUrl) || !!window.BLADERBOEK_DEMO;
  $('downloadBtn').href = state.downloadUrl || '#';
  if (state.downloadName) $('downloadBtn').download = state.downloadName;
  $('bindingSeg').hidden = !state.meta.allowBindingSwitch;
  updateBindingButtons();
  const hash = location.hash.match(/^#p(\d+)$/);
  const start = hash ? state.pages.findIndex((p) => p.pdfPage === +hash[1]) : 0;
  build(Math.max(0, start));
  pumpQueue();
}

function setLoading(text, frac) {
  $('loadingText').textContent = text;
  $('loadingBar').style.width = Math.round(frac * 100) + '%';
}

// ---------- Paginalijst ----------
// Elke bladerpagina: { kind: 'pdf'|'cover'|'endpaper'|'blank', pdfPage?, role?: 'front'|'insideFront'|'insideBack'|'back' }
function buildPageList() {
  const n = state.pdfPageCount;
  const binding = state.binding;
  const pdf = (i) => ({ kind: 'pdf', pdfPage: i });
  const inside = () => ({ kind: binding === 'hardcover' ? 'endpaper' : 'blank' });
  let mode = state.meta.coverMode || 'outer';
  if (mode === 'full' && n < 6) mode = 'outer';
  if (mode === 'outer' && n < 3) mode = 'none';

  let front, insideFront, inner, insideBack, back;
  const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, k) => pdf(a + k));
  if (mode === 'full') {
    [front, insideFront, inner, insideBack, back] = [pdf(1), pdf(2), range(3, n - 2), pdf(n - 1), pdf(n)];
  } else if (mode === 'outer') {
    [front, insideFront, inner, insideBack, back] = [pdf(1), inside(), range(2, n - 1), inside(), pdf(n)];
  } else {
    [front, insideFront, inner, insideBack, back] = [{ kind: 'cover' }, inside(), range(1, n), inside(), { kind: 'cover' }];
  }
  // Een boek heeft altijd een even aantal pagina's; een geniet magazine een veelvoud van vier.
  const multiple = binding === 'magazine' ? 4 : 2;
  while (inner.length % multiple) inner.push({ kind: 'blank' });

  front.role = 'front'; insideFront.role = 'insideFront'; insideBack.role = 'insideBack'; back.role = 'back';
  state.pages = [front, insideFront, ...inner, insideBack, back];
  state.innerCount = inner.length;
}

function pageLabel(p) {
  if (p.role === 'front') return 'Voorkant';
  if (p.role === 'back') return 'Achterkant';
  if (p.pdfPage) return `Pagina ${p.pdfPage}`;
  if (p.role === 'insideFront' || p.role === 'insideBack') return 'Binnenkant omslag';
  return 'Lege pagina';
}

// ---------- PDF renderen ----------
async function renderPdfPage(num) {
  if (state.images.has(num)) return state.images.get(num);
  const page = await state.pdf.getPage(num);
  const base = page.getViewport({ scale: 1 });
  const t = state.trimInset || { left: 0, top: 0, right: 0, bottom: 0 };
  const rotated = page.rotate % 180 !== 0;
  const trimW = rotated ? base.width - t.top - t.bottom : base.width - t.left - t.right;
  const trimH = rotated ? base.height - t.left - t.right : base.height - t.top - t.bottom;
  const scale = state.renderHeight / trimH;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(trimW * scale);
  canvas.height = Math.round(trimH * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const offX = (rotated ? t.bottom : t.left) * scale, offY = (rotated ? t.left : t.top) * scale;
  await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -offX, -offY] }).promise;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  const url = URL.createObjectURL(blob);
  state.images.set(num, url);
  page.cleanup();
  document.querySelectorAll(`img[data-pdf="${num}"]`).forEach((img) => {
    img.src = url;
    img.parentElement.classList.remove('loading-page');
  });
  return url;
}

// Rendert pagina's in volgorde van afstand tot de huidige pagina.
async function pumpQueue() {
  if (state.rendering) return;
  state.rendering = true;
  try {
    for (;;) {
      const cur = state.flip ? state.flip.getCurrentPageIndex() : 0;
      let best = null, bestD = Infinity;
      state.pages.forEach((p, i) => {
        if (p.pdfPage && !state.images.has(p.pdfPage)) {
          const d = Math.abs(i - cur) + (i < cur ? 0.5 : 0);
          if (d < bestD) { bestD = d; best = p.pdfPage; }
        }
      });
      if (best == null) break;
      await renderPdfPage(best);
    }
  } catch (e) {
    console.error(e);
  } finally {
    state.rendering = false;
  }
}

async function sampleCoverColor(url) {
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const c = document.createElement('canvas');
    c.width = 40; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 40, 60);
    const d = ctx.getImageData(0, 0, 40, 60).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < 60; y++) for (let x = 0; x < 40; x++) {
      if (x > 2 && x < 37 && y > 2 && y < 57) continue; // alleen de rand
      const k = (y * 40 + x) * 4; r += d[k]; g += d[k + 1]; b += d[k + 2]; n++;
    }
    return '#' + [r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('');
  } catch {
    return state.coverColor;
  }
}

// ---------- Boek opbouwen ----------
function computeLayout() {
  const area = $('bookArea');
  const W = area.clientWidth, H = area.clientHeight;
  const b = BINDINGS[state.binding];
  // Ruimte voor kaft-overstek, papierblok en schaduw.
  const reserveX = W < 640 ? 96 : 150, reserveY = W < 640 ? 130 : 150; // ruimte voor de pijltjes naast het boek
  const fit = (pagesAcross) => Math.max(120, Math.min(H - reserveY, (W - reserveX) / (pagesAcross * state.aspect)));
  const hL = fit(2), hP = fit(1);
  const landscape = W >= 640 && hL >= 0.55 * hP;
  const ph = Math.floor(landscape ? hL : hP);
  const pw = Math.floor(ph * state.aspect);
  return { landscape, pw, ph, b };
}

function build(startIndex) {
  const { landscape, pw, ph } = computeLayout();
  state.landscape = landscape;
  state.pw = pw;
  state.ph = ph;
  const host = $('bookHost');
  host.style.width = (landscape ? pw * 2 : pw) + 'px';
  host.style.height = ph + 'px';
  host.style.marginLeft = -(landscape ? pw : pw / 2) + 'px';
  host.style.marginTop = -ph / 2 - 8 + 'px';
  document.body.classList.remove('b-hardcover', 'b-softcover', 'b-magazine');
  document.body.classList.add('b-' + state.binding);
  document.documentElement.style.setProperty('--cover', state.coverColor);
  document.documentElement.style.setProperty('--endpaper', mix(state.coverColor, '#f4efe4', 0.9));

  if (state.flip) { try { state.flip.destroy(); } catch {} state.flip = null; }
  const slot = $('flipSlot');
  slot.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'flip-root';
  slot.appendChild(root);

  const last = state.pages.length - 1;
  const hard = state.binding === 'hardcover';
  const els = state.pages.map((p, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    const side = !landscape ? 'p-right' : i % 2 === 1 ? 'p-left' : 'p-right';
    el.classList.add(side);
    if (p.role === 'front') el.classList.add('cover');
    if (p.role === 'back') el.classList.add('cover', 'back');
    if (BINDINGS[state.binding].glossy || (p.role === 'front' || p.role === 'back')) el.classList.add('glossy');
    if (hard && p.role) el.dataset.density = 'hard';
    if (p.kind === 'pdf') {
      const img = document.createElement('img');
      img.dataset.pdf = p.pdfPage;
      img.alt = pageLabel(p);
      img.draggable = false;
      const url = state.images.get(p.pdfPage);
      if (url) img.src = url; else el.classList.add('loading-page');
      el.appendChild(img);
    } else if (p.kind === 'cover') {
      const c = document.createElement('div');
      c.className = 'gen-cover';
      c.textContent = p.role === 'front' ? state.meta.title || '' : '';
      el.appendChild(c);
    } else if (p.kind === 'endpaper') {
      el.classList.add('endpaper');
    } else {
      el.classList.add('blank');
    }
    root.appendChild(el);
    return el;
  });

  const flip = new St.PageFlip(root, {
    width: pw,
    height: ph,
    size: 'stretch',
    minWidth: landscape ? 50 : pw,
    maxWidth: 6000,
    minHeight: 50,
    maxHeight: 6000,
    autoSize: false,
    usePortrait: !landscape,
    showCover: true,
    drawShadow: true,
    maxShadowOpacity: state.binding === 'magazine' ? 0.35 : 0.5,
    flippingTime: state.binding === 'hardcover' ? 1100 : state.binding === 'magazine' ? 750 : 900,
    mobileScrollSupport: false,
    startPage: Math.max(0, Math.min(startIndex, last)),
    swipeDistance: 25,
    showPageCorners: true,
  });
  root.style.minWidth = '0';
  flip.loadFromHTML(els);

  // StPageFlip maakt de omslag altijd hard; bij soft- en magazine moet hij juist meebuigen.
  if (!hard) {
    const pages = flip.getPageCollection().getPages();
    pages[0].setDensity('soft');
    pages[last].setDensity('soft');
  }
  state.flip = flip;
  state.flipState = 'read';

  flip.on('flip', () => { onPageChange(); pumpQueue(); });
  flip.on('changeState', (e) => {
    state.flipState = e.data;
    $('pinLayer').classList.toggle('hidden', e.data !== 'read');
    if (e.data === 'flipping') {
      const idx = flip.getCurrentPageIndex();
      if (state.landscape && (idx === 0 || idx === last)) setShift(0); // boek gaat open: naar het midden schuiven
    }
    if (e.data === 'read') updateDecor();
  });

  $('pageSlider').max = String(last);
  onPageChange(true);
}

function setShift(px, instant) {
  const host = $('bookHost');
  if (instant) host.style.transition = 'none';
  host.style.transform = `translateX(${px}px)`;
  if (instant) { host.offsetWidth; host.style.transition = ''; }
}

function onPageChange(instant) {
  const idx = state.flip.getCurrentPageIndex();
  const last = state.pages.length - 1;
  if (state.landscape) setShift(idx === 0 ? -state.pw / 2 : idx === last ? state.pw / 2 : 0, instant);
  else setShift(0, instant);
  $('pageSlider').value = String(idx);
  $('sidePrev').disabled = idx === 0;
  $('sideNext').disabled = idx === last;
  $('pageInfo').textContent = spreadLabel();
  updateDecor();
  renderComments();
  updateAboutSelect();
}

function visibleSides() {
  const idx = state.flip.getCurrentPageIndex();
  const last = state.pages.length - 1;
  if (!state.landscape) return { right: idx };
  if (idx === 0) return { right: 0 };
  if (idx === last) return { left: last };
  return { left: idx, right: idx + 1 };
}

function spreadLabel() {
  const v = visibleSides();
  const labels = [v.left, v.right].filter((i) => i != null).map((i) => state.pages[i]);
  const nums = labels.filter((p) => p.pdfPage).map((p) => p.pdfPage);
  if (nums.length === 2) return `Pagina ${nums[0]}–${nums[1]} van ${state.pdfPageCount}`;
  if (nums.length === 1 && !labels.some((p) => p.role === 'front' || p.role === 'back')) return `Pagina ${nums[0]} van ${state.pdfPageCount}`;
  return labels.map(pageLabel).join(' · ');
}

// ---------- Papierblok, kaft, rug ----------
function updateDecor() {
  if (!state.flip) return;
  const rect = state.flip.getBoundsRect();
  const { pw } = state;
  const h = rect.height;
  const b = BINDINGS[state.binding];
  const pxPerMm = h / state.pageMm.h;
  const last = state.pages.length - 1;
  const idx = state.flip.getCurrentPageIndex();
  const v = visibleSides();
  const innerSheets = state.innerCount / 2;
  let leftSheets;
  if (!state.landscape) leftSheets = idx === 0 ? 0 : idx === last ? innerSheets : Math.min(innerSheets, Math.max(0, Math.floor((idx - 1) / 2)));
  else leftSheets = idx === 0 ? 0 : idx === last ? innerSheets : Math.min(innerSheets, Math.max(0, (idx - 1) / 2));
  const sheets = { left: leftSheets, right: innerSheets - leftSheets };

  const coverEdge = shade(state.coverColor, -0.25);
  const boardPx = b.coverMm * pxPerMm;
  const ov = b.overhangMm ? Math.max(3, Math.min(14, b.overhangMm * pxPerMm)) : 0;

  for (const side of ['left', 'right']) {
    const block = $(side === 'left' ? 'blockLeft' : 'blockRight');
    const board = $(side === 'left' ? 'boardLeft' : 'boardRight');
    const pageIdx = v[side];
    if (pageIdx == null) { block.style.display = board.style.display = 'none'; continue; }
    const dir = side === 'left' ? -1 : 1;
    const x = side === 'left' ? rect.left : rect.left + (state.landscape ? pw : pw);
    const px = side === 'left' ? rect.left : state.landscape ? rect.left + pw : rect.left + pw;
    const closed = state.pages[pageIdx].role === 'front' || state.pages[pageIdx].role === 'back';
    const paperPx = sheets[side] * b.paperMm * pxPerMm;
    place(block, px, rect.top, pw, h);
    void x;

    if (state.binding === 'hardcover') {
      // Gesloten: het bord ligt bovenop (de omslag zelf), dan papier, dan het achterbord.
      // Open: de pagina ligt op het papierblok, dat op het bord ligt.
      const depth = closed ? 0 : paperPx;
      const layers = closed ? [[boardPx, coverEdge], [paperPx, 'paper'], [boardPx, coverEdge]] : [[boardPx, coverEdge]];
      const bx = side === 'left' ? px - ov : px;
      place(board, bx + dir * depth * 0.4, rect.top - ov + depth * 0.85, pw + ov, h + ov * 2);
      board.style.display = '';
      board.style.boxShadow = edgeShadows(layers, dir, true);
      block.style.display = closed ? 'none' : '';
      block.style.boxShadow = edgeShadows([[paperPx, 'paper']], dir, false);
    } else {
      board.style.display = 'none';
      block.style.display = '';
      const cover = Math.max(1, boardPx);
      const layers = closed ? [[cover, coverEdge], [paperPx, 'paper'], [cover, coverEdge]] : [[paperPx, 'paper'], [cover, coverEdge]];
      block.style.boxShadow = edgeShadows(layers, dir, true);
    }
  }

  // Nietjes in het middelste katern van een magazine.
  const staples = $('staples');
  const middle = state.pages.length / 2 - 1;
  if (state.binding === 'magazine' && state.landscape && idx === middle && state.flipState === 'read') {
    staples.style.display = 'block';
    place(staples, rect.left + pw, rect.top, 0, h);
  } else staples.style.display = 'none';

  renderPins();
  updatePickLayer();
  updatePlacard();
}

function place(el, x, y, w, h) {
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';
}

// Laagjes box-shadow: elke pixel dikte is een lijntje papier- of kaftrand, schuin naar buiten en omlaag.
function edgeShadows(layers, dir, drop) {
  const total = layers.reduce((s, [px]) => s + px, 0);
  const max = 46;
  const k = total > max ? max / total : 1;
  const out = [];
  let d = 0, line = 0;
  for (const [px, color] of layers) {
    const n = Math.round(px * k);
    for (let i = 0; i < n; i++) {
      d++;
      line++;
      const c = color === 'paper' ? (line % 2 ? '#f1ede4' : '#ddd7ca') : color;
      out.push(`${(dir * d * 0.4).toFixed(1)}px ${(d * 0.85).toFixed(1)}px 0 ${c}`);
    }
  }
  if (drop) {
    out.push(`${(dir * (d * 0.4 + 3)).toFixed(1)}px ${(d * 0.85 + 6).toFixed(1)}px 14px rgba(0,0,0,.35)`);
    out.push(`${(dir * (d * 0.4 + 10)).toFixed(1)}px ${(d * 0.85 + 18).toFixed(1)}px 40px rgba(0,0,0,.25)`);
  }
  return out.join(', ') || 'none';
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('');
}
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (p, s) => (p >> s) & 255;
  return '#' + [16, 8, 0].map((s) => Math.round(ch(pa, s) * (1 - t) + ch(pb, s) * t).toString(16).padStart(2, '0')).join('');
}

// ---------- Boekgegevens ----------
function updatePlacard() {
  const b = BINDINGS[state.binding];
  const w = state.pageMm.w, h = state.pageMm.h;
  const cm = (mm) => (Math.round(mm / 5) * 5 === Math.round(mm) && Math.round(mm) % 10 === 0 ? String(Math.round(mm) / 10) : (Math.round(mm) / 10).toLocaleString('nl-NL'));
  const known = [['A4', 210, 297], ['A5', 148, 210], ['A3', 297, 420], ['B5', 176, 250], ['A6', 105, 148], ['Letter', 216, 279]];
  const std = known.find(([, a, c]) => Math.abs(Math.min(w, h) - a) < 1.5 && Math.abs(Math.max(w, h) - c) < 1.5);
  const orient = Math.abs(w - h) < 2 ? 'vierkant' : w > h ? 'liggend' : 'staand';
  $('plTitle').textContent = state.meta.title || '';
  $('plFormat').textContent = `Formaat ${cm(w)} × ${cm(h)} cm${std ? ` (${std[0]})` : ''}, ${orient}`;
  const spineMm = (state.innerCount / 2) * b.paperMm + 2 * b.coverMm + (state.binding === 'hardcover' ? 1.5 : 0);
  const spine = state.binding === 'magazine' ? 'geniet' : `rug ca. ${spineMm < 10 ? spineMm.toFixed(1).replace('.', ',') : Math.round(spineMm)} mm`;
  $('plExtent').textContent = `${state.pdfPageCount} pagina's · ${b.label} · ${spine}`;
  $('placard').hidden = false;
}

// ---------- Opmerkingen ----------
async function loadComments() {
  if (state.mode === 'server') {
    try {
      const res = await fetch(`/api/books/${state.bookId}/comments`);
      state.comments = res.ok ? await res.json() : [];
    } catch { state.comments = []; }
  } else {
    try { state.comments = JSON.parse(localStorage.getItem(state.localKey) || '[]'); } catch { state.comments = []; }
  }
  $('commentCount').textContent = state.comments.length ? String(state.comments.length) : '';
}

async function addComment({ text, author, page, x, y }) {
  text = text.trim();
  if (!text) return false;
  author = author.trim();
  try { localStorage.setItem('bladerboek:author', author); } catch {}
  const body = { text, author, page: page || null, x: x ?? null, y: y ?? null };
  if (state.mode === 'server') {
    const res = await fetch(`/api/books/${state.bookId}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { toast('Opmerking kon niet worden opgeslagen'); return false; }
    state.comments.push(await res.json());
  } else {
    state.comments.push({ ...body, author: author || 'Anoniem', id: Math.random().toString(36).slice(2), resolved: false, createdAt: new Date().toISOString() });
    try { localStorage.setItem(state.localKey, JSON.stringify(state.comments)); } catch {}
  }
  $('commentCount').textContent = String(state.comments.length);
  renderComments();
  renderPins();
  toast(state.mode === 'server' ? 'Opmerking geplaatst, bedankt!' : 'Opmerking opgeslagen in deze browser');
  return true;
}

function visiblePdfPages() {
  const v = visibleSides();
  return [v.left, v.right].filter((i) => i != null).map((i) => state.pages[i].pdfPage).filter(Boolean);
}

function renderComments() {
  const list = $('commentList');
  const visible = visiblePdfPages();
  const numbered = state.comments.map((c, i) => ({ ...c, n: i + 1 }));
  let items = numbered;
  if (state.filter === 'spread') items = numbered.filter((c) => c.page && visible.includes(c.page));
  if (state.filter === 'general') items = numbered.filter((c) => !c.page);
  if (state.filter === 'all') items = [...numbered].sort((a, b) => (a.page || 0) - (b.page || 0));
  list.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.filter === 'spread' ? 'Nog geen opmerkingen op deze pagina\'s.' : state.filter === 'general' ? 'Nog geen algemene opmerkingen.' : 'Nog geen opmerkingen.';
    list.appendChild(li);
    return;
  }
  for (const c of items) {
    const li = document.createElement('li');
    li.dataset.id = c.id;
    if (c.page) li.classList.add('has-page');
    if (c.resolved) li.classList.add('resolved');
    if (state.activeComment === c.id) li.classList.add('active');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const who = document.createElement('span');
    who.innerHTML = `<span class="who"></span> · ${formatDate(c.createdAt)}`;
    who.querySelector('.who').textContent = c.author || 'Anoniem';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = (c.x != null ? `#${c.n} · ` : '') + (c.page ? `pagina ${c.page}` : 'algemeen') + (c.resolved ? ' · afgehandeld' : '');
    meta.append(who, tag);
    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = c.text;
    li.append(meta, txt);
    if (c.page) li.addEventListener('click', () => goToPdfPage(c.page, c.id));
    list.appendChild(li);
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function goToPdfPage(num, commentId) {
  const i = state.pages.findIndex((p) => p.pdfPage === num);
  if (i < 0) return;
  state.activeComment = commentId || null;
  if (visiblePdfPages().includes(num)) { renderComments(); renderPins(); return; }
  state.flip.flip(i);
}

function renderPins() {
  const layer = $('pinLayer');
  layer.innerHTML = '';
  if (!state.flip || !state.meta.allowComments) return;
  const rect = state.flip.getBoundsRect();
  const v = visibleSides();
  for (const side of ['left', 'right']) {
    const i = v[side];
    if (i == null || !state.pages[i].pdfPage) continue;
    const x0 = side === 'left' ? rect.left : rect.left + state.pw;
    state.comments.forEach((c, k) => {
      if (c.page !== state.pages[i].pdfPage || c.x == null) return;
      const pin = document.createElement('div');
      pin.className = 'pin' + (c.resolved ? ' resolved' : '') + (state.activeComment === c.id ? ' active' : '');
      pin.style.left = x0 + c.x * state.pw + 'px';
      pin.style.top = rect.top + c.y * rect.height + 'px';
      pin.title = `${c.author}: ${c.text}`;
      pin.innerHTML = `<span>${k + 1}</span>`;
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        state.activeComment = c.id;
        openPanel();
        state.filter = 'spread';
        syncFilterButtons();
        renderComments();
        renderPins();
        document.querySelector(`#commentList li[data-id="${c.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      ['mousedown', 'touchstart', 'pointerdown'].forEach((ev) => pin.addEventListener(ev, (e) => e.stopPropagation()));
      layer.appendChild(pin);
    });
  }
}

function setPinMode(on) {
  state.pinMode = on;
  if (on) closePanel(); // popup opzij, zodat je het boek kunt aanklikken
  $('pinBtn').classList.toggle('on', on);
  $('pinBtn').lastChild.textContent = on ? ' Klik nu op de plek in het boek…' : ' Prik een opmerking op de pagina';
  updatePickLayer();
}

function updatePickLayer() {
  const layer = $('pickLayer');
  layer.innerHTML = '';
  if (!state.pinMode || !state.flip) { layer.hidden = true; return; }
  const rect = state.flip.getBoundsRect();
  const v = visibleSides();
  const left = v.left != null ? rect.left : rect.left + state.pw;
  const right = v.right != null ? rect.left + 2 * state.pw : rect.left + state.pw;
  const r = state.landscape ? { left, right } : { left: rect.left + state.pw, right: rect.left + 2 * state.pw };
  place(layer, r.left, rect.top, r.right - r.left, rect.height);
  const hint = document.createElement('div');
  hint.className = 'pick-hint';
  hint.textContent = 'Klik op de plek waar je opmerking over gaat · Esc om te stoppen';
  layer.appendChild(hint);
  layer.hidden = false;
}

function onPick(e) {
  const rect = state.flip.getBoundsRect();
  const hostBox = $('bookHost').getBoundingClientRect();
  const x = e.clientX - hostBox.left, y = e.clientY - hostBox.top;
  const v = visibleSides();
  const onLeft = state.landscape && x < rect.left + state.pw;
  const idx = onLeft ? v.left : v.right;
  const page = idx != null ? state.pages[idx] : null;
  if (!page || !page.pdfPage) return toast('Kies een pagina met inhoud');
  const x0 = onLeft || !state.landscape ? rect.left + (state.landscape ? 0 : state.pw) : rect.left + state.pw;
  state.pending = {
    page: page.pdfPage,
    x: Math.min(1, Math.max(0, (x - x0) / state.pw)),
    y: Math.min(1, Math.max(0, (y - rect.top) / rect.height)),
  };
  setPinMode(false);
  const pop = $('pinPopover');
  $('pinPopTitle').textContent = `Opmerking op pagina ${page.pdfPage}`;
  $('pinText').value = '';
  $('pinAuthor').value = savedAuthor();
  pop.hidden = false;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = Math.min(window.innerWidth - pw - 10, Math.max(10, e.clientX + 14)) + 'px';
  pop.style.top = Math.min(window.innerHeight - ph - 10, Math.max(10, e.clientY - 20)) + 'px';
  // Tijdelijke speld tonen op de gekozen plek.
  const pin = document.createElement('div');
  pin.className = 'pin active';
  pin.style.left = x0 + state.pending.x * state.pw + 'px';
  pin.style.top = rect.top + state.pending.y * rect.height + 'px';
  pin.innerHTML = '<span>+</span>';
  $('pinLayer').appendChild(pin);
  $('pinText').focus();
}

function closePinPopover() {
  $('pinPopover').hidden = true;
  state.pending = null;
  renderPins();
}

function savedAuthor() {
  try { return localStorage.getItem('bladerboek:author') || ''; } catch { return ''; }
}

function updateAboutSelect() {
  const sel = $('aboutSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  sel.add(new Option('Het hele boek (algemeen)', ''));
  for (const n of visiblePdfPages()) sel.add(new Option(`Pagina ${n}`, String(n)));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function openPanel() {
  $('panel').hidden = false;
  $('commentsBtn').setAttribute('aria-expanded', 'true');
}
function closePanel() {
  $('panel').hidden = true;
  $('commentsBtn').setAttribute('aria-expanded', 'false');
}

function syncFilterButtons() {
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.filter === state.filter));
}

// ---------- UI ----------
function setupUi() {
  const dz = $('dropzone');
  $('fileInput').addEventListener('change', (e) => openLocalFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (state.mode === 'local') dz.classList.add('over'); }));
  document.addEventListener('dragleave', () => dz.classList.remove('over'));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (state.mode === 'local' && e.dataTransfer.files[0]) openLocalFile(e.dataTransfer.files[0]);
  });

  $('bindingSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button')?.dataset.binding;
    if (!b || b === state.binding || !state.flip) return;
    const cur = state.pages[state.flip.getCurrentPageIndex()];
    state.binding = b;
    buildPageList();
    updateBindingButtons();
    let i = cur.pdfPage ? state.pages.findIndex((p) => p.pdfPage === cur.pdfPage) : state.pages.findIndex((p) => p.role && p.role === cur.role);
    if (i < 0) i = 0;
    build(i);
  });

  setEnv('studio'); // het boek start altijd op een lichte achtergrond
  $('envGroup').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.env;
    if (!v) return;
    setEnv(v);
  });

  const menuBtn = $('menuBtn'), menuPop = $('menuPop');
  const setMenu = (open) => { menuPop.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menuPop.hidden); });
  document.addEventListener('click', (e) => { if (!menuPop.hidden && !e.target.closest('.menu')) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  $('prevBtn').addEventListener('click', () => state.flip?.flipPrev('bottom'));
  $('sidePrev').addEventListener('click', () => state.flip?.flipPrev('bottom'));
  $('sideNext').addEventListener('click', () => state.flip?.flipNext('bottom'));
  $('nextBtn').addEventListener('click', () => state.flip?.flipNext('bottom'));
  $('firstBtn').addEventListener('click', () => state.flip?.flip(0));
  $('lastBtn').addEventListener('click', () => state.flip?.flip(state.pages.length - 1));
  $('pageSlider').addEventListener('input', (e) => { $('pageInfo').textContent = pageLabel(state.pages[+e.target.value]); });
  $('pageSlider').addEventListener('change', (e) => { state.flip?.turnToPage(+e.target.value); onPageChange(true); pumpQueue(); });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); state.flip?.flipNext('bottom'); pressFeedback('sideNext'); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); state.flip?.flipPrev('bottom'); pressFeedback('sidePrev'); }
    if (e.key === 'Home') state.flip?.flip(0);
    if (e.key === 'End') state.flip?.flip(state.pages.length - 1);
    if (e.key === 'Escape') { setPinMode(false); closePinPopover(); }
  });

  $('commentsBtn').addEventListener('click', () => { if ($('panel').hidden) openPanel(); else { closePanel(); setPinMode(false); } });
  $('closePanel').addEventListener('click', () => { closePanel(); setPinMode(false); });
  $('filters').addEventListener('click', (e) => {
    const f = e.target.closest('button')?.dataset.filter;
    if (!f) return;
    state.filter = f;
    syncFilterButtons();
    renderComments();
  });
  $('authorInput').value = savedAuthor();
  $('composeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const page = $('aboutSelect').value ? +$('aboutSelect').value : null;
    if (await addComment({ text: $('commentText').value, author: $('authorInput').value, page })) $('commentText').value = '';
  });
  $('pinBtn').addEventListener('click', () => setPinMode(!state.pinMode));
  $('pickLayer').addEventListener('click', onPick);
  $('pinCancel').addEventListener('click', closePinPopover);
  $('pinSave').addEventListener('click', async () => {
    if (!state.pending) return;
    const ok = await addComment({ text: $('pinText').value, author: $('pinAuthor').value, ...state.pending });
    if (ok) { $('authorInput').value = savedAuthor(); closePinPopover(); }
  });
  $('pinText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('pinSave').click(); });

  $('fullscreenBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });
  document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fs', !!document.fullscreenElement));

  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(relayout, 120); });
}

// Laat het pijltje naast het boek even 'indrukken' bij een toetsaanslag.
function pressFeedback(id) {
  const el = $(id);
  el.classList.add('pressed');
  setTimeout(() => el.classList.remove('pressed'), 150);
}

function setEnv(env) {
  document.body.classList.remove('env-desk', 'env-studio', 'env-dark', 'env-linen');
  document.body.classList.add('env-' + env);
  document.querySelectorAll('#envGroup button').forEach((b) => b.classList.toggle('on', b.dataset.env === env));
}

function updateBindingButtons() {
  document.querySelectorAll('#bindingSeg button').forEach((b) => b.classList.toggle('on', b.dataset.binding === state.binding));
}

function relayoutSoon() { requestAnimationFrame(relayout); }

function relayout() {
  if (!state.flip) return;
  const { landscape, pw, ph } = computeLayout();
  if (landscape === state.landscape && Math.abs(pw - state.pw) < 2 && Math.abs(ph - state.ph) < 2) return;
  build(state.flip.getCurrentPageIndex());
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

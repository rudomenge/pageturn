// Bladerboek-viewer: rendert een PDF als boek met realistische pageturn (StPageFlip),
// tekent papierblok, kaft en rug passend bij uitvoering en paginatal, en beheert opmerkingen.
import * as pdfjsLib from './vendor/pdf.min.mjs';
import { DEFAULT_HEADBANDS, headbandOf, headbandLabel, usableHeadbands } from './headbands.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const PT_TO_MM = 25.4 / 72;

// Fysieke eigenschappen per uitvoering (mm). Papier per vel, kaft per zijde.
const BINDINGS = {
  hardcover: { label: 'Hardcover', paperMm: 0.11, coverMm: 2.4, overhangMm: 3, glossy: false },
  softcover: { label: 'Softcover', paperMm: 0.10, coverMm: 0.35, overhangMm: 0, glossy: false },
  magazine: { label: 'Magazine', paperMm: 0.075, coverMm: 0.12, overhangMm: 0, glossy: true },
};

// Volume (cm³/g) per papiersoort, gelijk aan book3d.js: dikte per blad = g/m² × volume / 1000.
const PAPER_BULK = { gloss: 0.85, silk: 1.0, uncoated: 1.25, bulky: 1.8 };
const paperMm = () => (state.meta.paperGsm > 0
  ? (state.meta.paperGsm * (PAPER_BULK[state.meta.paperType] || 1)) / 1000
  : BINDINGS[state.binding].paperMm);

const state = {
  mode: 'local', // 'server' (deellink) of 'local' (zelf een PDF openen)
  bookId: null,
  meta: { title: 'Bladerboek', binding: 'hardcover', coverMode: 'outer', coverColor: 'auto', allowDownload: true, allowComments: true, allowBindingSwitch: true },
  pdf: null,
  coverPdf: null, // losse omslag-PDF (optioneel)
  coverTrim: null,
  epPdf: null, // schutblad-PDF (optioneel, alleen bij hardcover)
  epTrim: null,
  epHalves: [], // [{ page, part }] één helft per schutbladpagina
  owner: false, // bewerkmodus: browser van de eigenaar, niet als ?voorbeeld
  pdfPageCount: 0,
  pageMm: { w: 210, h: 297 },
  trimInset: null, // { left, top, right, bottom } in pt t.o.v. de zichtbare pagina
  aspect: 210 / 297,
  coverColor: '#f3f1ec', // hardcover zonder omslag: standaard wit
  pages: [], // beschrijving van elke bladerpagina
  innerCount: 0,
  images: new Map(), // imgKey(pagina) -> blob-URL
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
    const v = state.meta.pdfVersion ? `?v=${state.meta.pdfVersion}` : '';
    await openPdf({ url: `/api/books/${state.bookId}/pdf${v}` });
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
  if (state.coverPdf) { state.coverPdf.destroy(); state.coverPdf = null; }
  if (state.mode === 'server' && state.meta.coverPdf) {
    try {
      state.coverPdf = await pdfjsLib.getDocument({ url: `/api/books/${state.bookId}/coverpdf?v=${state.meta.coverPdf.version}`, isEvalSupported: false }).promise;
      state.coverTrim = state.meta.coverPdf.trim;
    } catch (e) {
      console.error(e);
    }
  }
  if (state.epPdf) { state.epPdf.destroy(); state.epPdf = null; }
  if (state.mode === 'server' && state.meta.endpaperPdf) {
    try {
      state.epPdf = await pdfjsLib.getDocument({ url: `/api/books/${state.bookId}/endpaperpdf?v=${state.meta.endpaperPdf.version}`, isEvalSupported: false }).promise;
      state.epTrim = state.meta.endpaperPdf.trim;
    } catch (e) {
      console.error(e);
    }
  }
  if (state.mode === 'server' && state.meta.trim) state.trimInset = state.meta.trim;

  const first = await state.pdf.getPage(1);
  const [x0, y0, x1, y1] = first.view;
  const t = state.trimInset || { left: 0, top: 0, right: 0, bottom: 0 };
  let wPt = x1 - x0 - t.left - t.right, hPt = y1 - y0 - t.top - t.bottom;
  if (first.rotate % 180) [wPt, hPt] = [hPt, wPt];
  state.pageMm = { w: wPt * PT_TO_MM, h: hPt * PT_TO_MM };
  state.aspect = wPt / hPt;
  state.coverSpread = false;
  if (state.coverPdf) {
    const cp = await state.coverPdf.getPage(1);
    const ct = state.coverTrim || { left: 0, top: 0, right: 0, bottom: 0 };
    let cw = cp.view[2] - cp.view[0] - ct.left - ct.right, ch = cp.view[3] - cp.view[1] - ct.top - ct.bottom;
    if (cp.rotate % 180) [cw, ch] = [ch, cw];
    state.coverSpread = cw / ch > state.aspect * 1.4;
  }
  // Schutblad: elke pagina is een spread (twee helften) of één losse pagina.
  state.epHalves = [];
  if (state.epPdf) {
    const et = state.epTrim || { left: 0, top: 0, right: 0, bottom: 0 };
    for (let i = 1; i <= Math.min(4, state.epPdf.numPages); i++) {
      const ep = await state.epPdf.getPage(i);
      let ew = ep.view[2] - ep.view[0] - et.left - et.right, eh = ep.view[3] - ep.view[1] - et.top - et.bottom;
      if (ep.rotate % 180) [ew, eh] = [eh, ew];
      if (ew / eh > state.aspect * 1.4) state.epHalves.push({ page: i, part: 'left' }, { page: i, part: 'right' });
      else state.epHalves.push({ page: i });
    }
  }
  state.renderHeight = Math.round(Math.min(2200, Math.max(1000, window.innerHeight * (window.devicePixelRatio || 1) * 1.1)));

  document.title = state.meta.title || 'Bladerboek';
  if (state.meta.coverColor && state.meta.coverColor !== 'auto') state.coverColor = state.meta.coverColor;

  await loadComments();
  setLoading('Pagina\'s worden voorbereid…', 0.3);

  // Eerst de omslag en de eerste pagina's renderen, de rest volgt op de achtergrond.
  state.binding = state.meta.binding in BINDINGS ? state.meta.binding : 'hardcover';
  buildPageList();
  const firstPages = state.pages.slice(0, 5).filter(imgKey);
  for (let i = 0; i < firstPages.length; i++) {
    await renderPage(firstPages[i]);
    setLoading('Pagina\'s worden voorbereid…', 0.3 + (0.6 * (i + 1)) / firstPages.length);
  }
  if ((!state.meta.coverColor || state.meta.coverColor === 'auto') && imgKey(state.pages[0])) {
    state.coverColor = await sampleCoverColor(state.images.get(imgKey(state.pages[0])));
  }
  $('loading').hidden = true;
  $('navbar').hidden = false;
  $('sidePrev').hidden = $('sideNext').hidden = false;
  $('commentsBtn').hidden = !state.meta.allowComments;
  setupOwner();
  $('downloadBtn').hidden = !(state.meta.allowDownload && state.downloadUrl) || !!window.BLADERBOEK_DEMO;
  $('downloadBtn').href = state.downloadUrl || '#';
  if (state.downloadName) $('downloadBtn').download = state.downloadName;
  $('bindingSeg').hidden = !state.meta.allowBindingSwitch;
  updateBindingButtons();
  const hash = location.hash.match(/^#p(\d+)$/);
  const start = hash ? state.pages.findIndex((p) => p.pdfPage === +hash[1]) : 0;
  build(Math.max(0, start));
  pumpQueue();
  startViewTracking();
}

function switchBinding(b) {
  if (!b || b === state.binding || !state.flip || !(b in BINDINGS)) return;
  const cur = state.pages[state.flip.getCurrentPageIndex()];
  state.binding = b;
  buildPageList();
  updateBindingButtons();
  let i = cur.pdfPage ? state.pages.findIndex((p) => p.pdfPage === cur.pdfPage) : state.pages.findIndex((p) => p.role && p.role === cur.role);
  if (i < 0) i = 0;
  build(i);
}

// ---------- Eigenaar: bewerkmodus en modus-label ----------
function setupOwner() {
  const ownerBrowser = state.mode === 'server' && isOwnerBrowser();
  const preview = new URLSearchParams(location.search).has('voorbeeld');
  state.owner = ownerBrowser && !preview;
  $('homeBtn').hidden = !state.owner;
  $('editMenu').hidden = !state.owner;
  const badge = $('modeBadge');
  badge.hidden = !ownerBrowser;
  if (!ownerBrowser) return;
  badge.classList.toggle('preview', preview);
  badge.innerHTML = preview
    ? '<i></i><span>Klantweergave</span><a href="#">Bewerken</a>'
    : '<i></i><span>Bewerken</span><a href="#">Bekijk als klant</a>';
  badge.querySelector('a').addEventListener('click', (e) => {
    e.preventDefault();
    const u = new URL(location.href);
    if (preview) u.searchParams.delete('voorbeeld'); else u.searchParams.set('voorbeeld', '');
    u.hash = currentHash();
    location.href = u.toString().replace('voorbeeld=', 'voorbeeld');
  });
  if (state.owner) setupEditMenu();
}

function currentHash() {
  const cur = state.flip && state.pages[state.flip.getCurrentPageIndex()];
  return cur?.pdfPage ? `#p${cur.pdfPage}` : '';
}

function reloadAtCurrentPage() {
  const u = new URL(location.href);
  u.hash = currentHash();
  history.replaceState(null, '', u.toString());
  location.reload();
}

async function adminFetch(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) throw new Error('Log eerst in op de beheerpagina');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setupEditMenu() {
  const btn = $('editBtn'), pop = $('editPop'), status = (t) => ($('edStatus').textContent = t);
  const setOpen = (open) => { pop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(pop.hidden); });
  document.addEventListener('click', (e) => { if (!pop.hidden && !e.target.closest('.edit-menu')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  const m = state.meta;
  $('edBinding').value = m.binding in BINDINGS ? m.binding : 'hardcover';
  $('edGsm').value = m.paperGsm || '';
  $('edPaper').value = m.paperType || 'silk';
  $('edCoverMode').value = m.coverMode || 'outer';
  $('edCoverModeWrap').hidden = !!m.coverPdf;

  const save = async (body) => {
    status('Opslaan…');
    try {
      const meta = await adminFetch(`/api/admin/books/${state.bookId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      Object.assign(state.meta, meta);
      status('Opgeslagen');
      setTimeout(() => status(''), 1500);
      return true;
    } catch (e) {
      status(e.message);
      return false;
    }
  };
  $('edTitle').value = m.title || '';
  $('edFileName').value = m.fileName || '';
  $('edTitle').addEventListener('change', async (e) => {
    if (await save({ title: e.target.value })) { document.title = state.meta.title; updatePlacard(); }
  });
  $('edFileName').addEventListener('change', async (e) => {
    if (await save({ fileName: e.target.value })) { $('edFileName').value = state.meta.fileName; updatePlacard(); fillEditFiles(); }
  });
  $('edHeadbandWrap').hidden = state.binding !== 'hardcover';
  setupHeadbandPicker(save);
  $('edBinding').addEventListener('change', async (e) => {
    if (await save({ binding: e.target.value })) { switchBinding(e.target.value); fillEditFiles(); $('edHeadbandWrap').hidden = state.binding !== 'hardcover'; }
  });
  const savePaper = async () => {
    if (await save({ paperGsm: $('edGsm').value.trim(), paperType: $('edPaper').value })) {
      $('edGsm').value = state.meta.paperGsm || '';
      updateDecor();
    }
  };
  $('edGsm').addEventListener('change', savePaper);
  $('edPaper').addEventListener('change', savePaper);
  $('edCoverMode').addEventListener('change', async (e) => { if (await save({ coverMode: e.target.value })) reloadAtCurrentPage(); });
  fillEditFiles();
}

// Kapitaalband kiezen uit de lijst van de beheerpagina (of de standaardlijst), of een eigen kleur.
async function setupHeadbandPicker(save) {
  const sel = $('edHeadband'), custom = $('edHbCustom'), sw = $('edHbSwatch');
  let list = DEFAULT_HEADBANDS;
  try { list = usableHeadbands(await adminFetch('/api/admin/headbands')); } catch {}
  const cur = headbandOf(state.meta);
  const same = (h) => h.colors.join() === cur.colors.join() && (h.code || '') === (cur.code || '');
  sel.innerHTML = list.map((h, i) => `<option value="${i}">${escapeHtml(headbandLabel(h))}</option>`).join('') + '<option value="custom">Eigen kleur…</option>';
  const idx = list.findIndex(same);
  sel.value = idx >= 0 ? String(idx) : 'custom';
  custom.hidden = idx >= 0;
  custom.value = cur.colors[0];
  const paint = (h) => {
    sw.style.background = `repeating-linear-gradient(90deg, ${h.colors[0]} 0 3px, ${h.colors[1] || shade(h.colors[0], luminance(h.colors[0]) > 0.5 ? -0.3 : 0.25)} 3px 5px)`;
    applyHeadband(h);
  };
  paint(cur);
  const choose = async (h) => {
    paint(h);
    if (await save({ headband: h })) updatePlacard();
  };
  sel.addEventListener('change', () => {
    custom.hidden = sel.value !== 'custom';
    if (sel.value === 'custom') return choose({ code: '', name: '', colors: [custom.value] });
    choose(list[+sel.value]);
  });
  custom.addEventListener('input', () => paint({ colors: [custom.value] }));
  custom.addEventListener('change', () => choose({ code: '', name: '', colors: [custom.value] }));
}

function fillEditFiles() {
  const m = state.meta, wrap = $('edFiles'), status = (t) => ($('edStatus').textContent = t);
  const rows = [
    ['pdf', 'Binnenwerk', `${m.fileName || 'boek.pdf'} · ${m.pageCount || state.pdfPageCount} pagina's`, true],
    ['coverpdf', 'Omslag', m.coverPdf ? m.coverPdf.fileName : 'spread of losse pagina\'s', !!m.coverPdf],
    ['endpaperpdf', 'Schutblad', m.endpaperPdf ? m.endpaperPdf.fileName + (state.binding !== 'hardcover' ? ' · alleen bij hardcover' : '') : 'alleen bij hardcover', !!m.endpaperPdf],
  ];
  wrap.innerHTML = '<div class="menu-label">Bestanden</div>' + rows.map(([w, label, sub, has]) => `<div class="ed-file">
      <div class="grow"><div>${label}</div><div class="sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div></div>
      <label class="btn">${has ? 'Vervangen' : 'Toevoegen'}<input type="file" accept="application/pdf,.pdf" data-up="${w}" hidden></label>
      ${has && w !== 'pdf' ? `<button class="x" data-rm="${w}" title="${label} verwijderen" aria-label="${label} verwijderen">✕</button>` : ''}
    </div>`).join('');
  wrap.querySelectorAll('[data-up]').forEach((input) => input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const which = input.dataset.up;
    try {
      if (which === 'pdf' && state.comments.some((c) => c.page) && !confirm('Opmerkingen blijven gekoppeld aan hun paginanummer. Klopt de nummering in de nieuwe PDF nog? Doorgaan?')) return;
      status('PDF wordt gecontroleerd…');
      const data = new Uint8Array(await file.arrayBuffer());
      const { PDFDocument } = await import('./vendor/pdf-lib.esm.min.js');
      const doc = await PDFDocument.load(data, { updateMetadata: false, ignoreEncryption: true });
      const pg = doc.getPage(0), crop = pg.getCropBox(), trimBox = pg.getTrimBox();
      const trim = insetFrom(crop, trimBox);
      const q = new URLSearchParams({ fileName: file.name, pageCount: String(doc.getPageCount()) });
      if (trim) q.set('trim', JSON.stringify(trim));
      if (which === 'pdf') {
        q.set('pageSize', JSON.stringify({ widthMm: trimBox.width * PT_TO_MM, heightMm: trimBox.height * PT_TO_MM }));
        q.set('colorProfile', (await import('./preflight.js')).colorProfileOf(doc));
      }
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => status(`Uploaden… ${Math.round((e.loaded / e.total) * 100)}%`);
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 401 ? 'Log eerst in op de beheerpagina' : 'Uploaden mislukt')));
        xhr.onerror = () => reject(new Error('Uploaden mislukt, controleer je verbinding'));
        xhr.open('PUT', `/api/admin/books/${state.bookId}/${which}?${q}`);
        xhr.setRequestHeader('Content-Type', 'application/pdf');
        xhr.send(file);
      });
      status('Klaar, het boek wordt opnieuw geladen…');
      reloadAtCurrentPage();
    } catch (e) {
      status(e.message || 'Dit bestand kon niet als PDF worden gelezen');
    }
  }));
  wrap.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`${b.dataset.rm === 'coverpdf' ? 'Losse omslag' : 'Schutblad'} verwijderen?`)) return;
    try {
      await adminFetch(`/api/admin/books/${state.bookId}/${b.dataset.rm}`, { method: 'DELETE' });
      reloadAtCurrentPage();
    } catch (e) {
      status(e.message);
    }
  }));
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
  if (state.coverPdf) {
    // Losse omslag: de PDF van het boek is dan helemaal binnenwerk.
    const c = state.coverPdf.numPages;
    const cov = (i, part) => ({ kind: 'pdf', coverPage: i, part });
    inner = range(1, n);
    [insideFront, insideBack] = [inside(), inside()];
    if (state.coverSpread) [front, back] = [cov(1, 'front'), cov(1, 'back')];
    else if (c >= 4) [front, insideFront, insideBack, back] = [cov(1), cov(2), cov(c - 1), cov(c)];
    else [front, back] = [cov(1), c > 1 ? cov(c) : { kind: 'cover' }];
  } else if (mode === 'full') {
    [front, insideFront, inner, insideBack, back] = [pdf(1), pdf(2), range(3, n - 2), pdf(n - 1), pdf(n)];
  } else if (mode === 'outer') {
    [front, insideFront, inner, insideBack, back] = [pdf(1), inside(), range(2, n - 1), inside(), pdf(n)];
  } else {
    [front, insideFront, inner, insideBack, back] = [{ kind: 'cover' }, inside(), range(1, n), inside(), { kind: 'cover' }];
  }
  // Een boek heeft altijd een even aantal pagina's; een geniet magazine een veelvoud van vier.
  const multiple = binding === 'magazine' ? 4 : 2;
  while (inner.length % multiple) inner.push({ kind: 'blank' });

  // Schutblad bij hardcover: binnenkant kaft plus een los schutblad, voor en achter.
  let flyFront = null, flyBack = null;
  const h = state.epHalves;
  if (binding === 'hardcover' && h.length) {
    const ep = (x) => ({ kind: 'pdf', epPage: x.page, part: x.part });
    const pick = (k) => (h.length >= 4 ? h[[0, 1, h.length - 2, h.length - 1][k]] : h[k % h.length]);
    [insideFront, flyFront, flyBack, insideBack] = [ep(pick(0)), ep(pick(1)), ep(pick(2)), ep(pick(3))];
  }

  front.role = 'front'; insideFront.role = 'insideFront'; insideBack.role = 'insideBack'; back.role = 'back';
  state.pages = [front, insideFront, ...(flyFront ? [flyFront] : []), ...inner, ...(flyBack ? [flyBack] : []), insideBack, back];
  state.innerCount = inner.length;
}

function pageLabel(p) {
  if (p.epPage) return 'Schutblad';
  if (p.role === 'front') return 'Voorkant';
  if (p.role === 'back') return 'Achterkant';
  if (p.pdfPage) return `Pagina ${p.pdfPage}`;
  if (p.role === 'insideFront' || p.role === 'insideBack') return 'Binnenkant omslag';
  return 'Lege pagina';
}

// ---------- PDF renderen ----------
// Sleutel van het plaatje van een bladerpagina: '12' (binnenwerk) of 'c1front' (losse omslag).
function imgKey(p) {
  if (p.coverPage) return `c${p.coverPage}${p.part || ''}`;
  if (p.epPage) return `e${p.epPage}${p.part || ''}`;
  return p.pdfPage ? String(p.pdfPage) : null;
}

async function renderPage(p) {
  const key = imgKey(p);
  if (state.images.has(key)) return state.images.get(key);
  const doc = p.coverPage ? state.coverPdf : p.epPage ? state.epPdf : state.pdf;
  const page = await doc.getPage(p.coverPage || p.epPage || p.pdfPage);
  const base = page.getViewport({ scale: 1 });
  const t = (p.coverPage ? state.coverTrim : p.epPage ? state.epTrim : state.trimInset) || { left: 0, top: 0, right: 0, bottom: 0 };
  const rotated = page.rotate % 180 !== 0;
  const trimW = rotated ? base.width - t.top - t.bottom : base.width - t.left - t.right;
  const trimH = rotated ? base.height - t.left - t.right : base.height - t.top - t.bottom;
  // Bij een omslag als spread (achterkant, rug, voorkant) snijden we de voor- of achterkant eruit;
  // een schutblad-spread delen we in twee helften.
  const partW = p.part === 'left' || p.part === 'right' ? trimW / 2 : p.part ? Math.min(trimW, trimH * state.aspect) : trimW;
  const partX = p.part === 'front' || p.part === 'right' ? trimW - partW : 0;
  const scale = state.renderHeight / trimH;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(partW * scale);
  canvas.height = Math.round(trimH * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const offX = ((rotated ? t.bottom : t.left) + partX) * scale, offY = (rotated ? t.left : t.top) * scale;
  await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -offX, -offY] }).promise;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  const url = URL.createObjectURL(blob);
  state.images.set(key, url);
  page.cleanup();
  document.querySelectorAll(`img[data-key="${key}"]`).forEach((img) => {
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
        const key = imgKey(p);
        if (key && !state.images.has(key)) {
          const d = Math.abs(i - cur) + (i < cur ? 0.5 : 0);
          if (d < bestD) { bestD = d; best = p; }
        }
      });
      if (best == null) break;
      await renderPage(best);
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
  document.documentElement.style.setProperty('--cover-ink', luminance(state.coverColor) > 0.6 ? '#1d2430' : '#fff');
  applyHeadband(headbandOf(state.meta));
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
      img.dataset.key = imgKey(p);
      img.alt = pageLabel(p);
      img.draggable = false;
      const url = state.images.get(imgKey(p));
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
  noteViewedPages();
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
  return [...new Set(labels.map(pageLabel))].join(' · ');
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
    const paperPx = sheets[side] * paperMm() * pxPerMm;
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

  // Open hardcover: tussen de borden loopt de rug, zichtbaar boven en onder het papier.
  const sm = $('spineMid');
  if (state.binding === 'hardcover' && state.landscape && v.left != null && v.right != null) {
    const spinePx = Math.max(6, Math.min(60, (state.innerCount / 2) * paperMm() * pxPerMm + 2 * boardPx));
    const joint = Math.max(3, 4 * pxPerMm);
    const w = spinePx + 2 * joint;
    const depth = (sheets.left + sheets.right) / 2 * paperMm() * pxPerMm;
    const dark = shade(state.coverColor, -0.45), mid = shade(state.coverColor, -0.15), light = shade(state.coverColor, 0.12);
    const j = (joint / w) * 100;
    sm.style.background = `linear-gradient(90deg, ${mid} 0, ${dark} ${j * 0.6}%, ${mid} ${j}%, ${light} 50%, ${mid} ${100 - j}%, ${dark} ${100 - j * 0.6}%, ${mid} 100%)`;
    // De rug ligt iets hoger dan de borden (hij buigt om het papierblok heen) en blijft daardoor boven en onder zichtbaar.
    const smTop = rect.top - ov * 1.3 + Math.min(depth, ov) * 0.3;
    place(sm, rect.left + pw - w / 2, smTop, w, h + ov * 2.6);
    // Kapitaalbandjes: net boven en onder het papierblok, tussen de groeven.
    const hb = Math.max(2.5, 2 * pxPerMm);
    sm.style.setProperty('--joint', joint + 'px');
    sm.style.setProperty('--hb', hb + 'px');
    sm.style.setProperty('--hb-top', rect.top - smTop - hb + 'px');
    sm.style.display = 'block';
  } else sm.style.display = 'none';

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

function applyHeadband(h) {
  const [a, b] = h.colors;
  document.documentElement.style.setProperty('--headband', a);
  document.documentElement.style.setProperty('--headband2', b || shade(a, luminance(a) > 0.5 ? -0.3 : 0.25));
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
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
  const spineMm = (state.innerCount / 2) * paperMm() + 2 * b.coverMm + (state.binding === 'hardcover' ? 1.5 : 0);
  const spine = state.binding === 'magazine' ? 'geniet' : `rug ca. ${spineMm < 10 ? spineMm.toFixed(1).replace('.', ',') : Math.round(spineMm)} mm`;
  $('plExtent').textContent = `${state.pdfPageCount} pagina's · ${b.label} · ${spine}`;
  const PAPER_NAMES = { gloss: 'glans', silk: 'mat', uncoated: 'ongestreken', bulky: 'romandruk' };
  const paper = state.meta.paperGsm ? `Papier ${state.meta.paperGsm} g/m² ${PAPER_NAMES[state.meta.paperType] || 'mat'}` : '';
  const band = headbandOf(state.meta);
  const hb = state.binding === 'hardcover' ? `kapitaalband ${[(band.name || '').toLowerCase(), band.code].filter(Boolean).join(' ') || 'eigen kleur'}` : '';
  $('plPaper').textContent = [paper, hb].filter(Boolean).join(' · ').replace(/^k/, (c) => (paper ? c : 'K'));
  $('plPaper').hidden = !paper && !hb;
  // Alleen voor de eigenaar: bestandsnaam en kleurprofiel.
  const own = $('plOwner');
  own.hidden = !state.owner;
  if (state.owner) {
    const prof = state.meta.colorProfile === undefined ? 'kleurprofiel onbekend' : state.meta.colorProfile || 'geen kleurprofiel';
    own.textContent = `${state.meta.fileName || ''} · ${prof}`;
  }
  $('placard').hidden = false;
}

// ---------- Bekeken-registratie ----------
// Alleen bij een deellink, en niet als de eigenaar zelf kijkt (de beheerpagina zet een vlag in deze browser).
const view = { id: null, seconds: 0, maxPage: 0, sent: '', lastTick: 0 };

function isOwnerBrowser() {
  try { return localStorage.getItem('bladerboek:owner') === '1'; } catch { return false; }
}

async function startViewTracking() {
  if (state.mode !== 'server' || isOwnerBrowser() || new URLSearchParams(location.search).has('voorbeeld')) return;
  try {
    const res = await fetch(`/api/books/${state.bookId}/views`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxPage: view.maxPage }),
    });
    if (!res.ok) return;
    view.id = (await res.json()).id;
  } catch { return; }
  view.lastTick = Date.now();
  setInterval(() => { tickView(); sendView(false); }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { tickView(); sendView(true); } else view.lastTick = Date.now();
  });
  window.addEventListener('pagehide', () => { tickView(); sendView(true); });
}

function tickView() {
  if (!view.lastTick || document.hidden) return;
  const now = Date.now();
  view.seconds += Math.min(60, (now - view.lastTick) / 1000);
  view.lastTick = now;
}

function noteViewedPages() {
  for (const n of visiblePdfPages()) view.maxPage = Math.max(view.maxPage, n);
}

function sendView(beacon) {
  if (!view.id) return;
  const body = JSON.stringify({ seconds: Math.round(view.seconds), maxPage: view.maxPage, name: savedAuthor() || undefined });
  if (body === view.sent) return;
  view.sent = body;
  const url = `/api/books/${state.bookId}/views/${encodeURIComponent(view.id)}`;
  if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
  else fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
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

  $('bindingSeg').addEventListener('click', (e) => switchBinding(e.target.closest('button')?.dataset.binding));

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
  document.body.classList.remove('env-grey', 'env-studio', 'env-dark', 'env-linen');
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

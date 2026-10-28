// 3D-boekje met CSS-transforms: voorkant, rug, papierrand en bovenkant op echte verhoudingen
// (formaat in mm, dikte uit paginatal en uitvoering). Gebruikt door de beheerpagina als thumbnail.

// Fysieke eigenschappen per uitvoering (mm). Papier per vel, kaft per zijde.
export const BINDINGS = {
  hardcover: { label: 'Hardcover', paperMm: 0.11, coverMm: 2.4, overhangMm: 3, glossy: false },
  softcover: { label: 'Softcover', paperMm: 0.10, coverMm: 0.35, overhangMm: 0, glossy: false },
  magazine: { label: 'Magazine', paperMm: 0.075, coverMm: 0.12, overhangMm: 0, glossy: true },
};

// Volume (cm³/g) per papiersoort: dikte van één vel in mm = g/m² × volume / 1000.
export const PAPERS = {
  gloss: { label: 'Gestreken glans (mc)', bulk: 0.85 },
  silk: { label: 'Gestreken mat / silk', bulk: 1.0 },
  uncoated: { label: 'Ongestreken (offset)', bulk: 1.25 },
  bulky: { label: 'Romandruk / volumineus', bulk: 1.8 },
};

// Dikte van één blad (2 pagina's) in mm: uit grammage en papiersoort, anders een standaard per uitvoering.
export function paperMmFor(binding, paperGsm, paperType) {
  if (paperGsm > 0) return (paperGsm * (PAPERS[paperType] || PAPERS.silk).bulk) / 1000;
  return (BINDINGS[binding] || BINDINGS.hardcover).paperMm;
}

export function spineMm(binding, pages, paperMm) {
  const b = BINDINGS[binding] || BINDINGS.hardcover;
  return Math.ceil(pages / 2) * (paperMm || b.paperMm) + 2 * b.coverMm + (binding === 'hardcover' ? 1.5 : 0);
}

const CSS = `
.b3d { position: relative; display: flex; align-items: center; justify-content: center; perspective: 1500px; perspective-origin: 50% 15%; }
.b3d-shadow { position: absolute; left: 50%; bottom: 4%; width: 78%; height: 9%; transform: translateX(-46%);
  background: radial-gradient(ellipse at center, rgba(0,0,0,.32), rgba(0,0,0,0) 70%); filter: blur(4px); }
.b3d-book { position: relative; transform-style: preserve-3d; transform: rotateY(-36deg); transition: transform .5s cubic-bezier(.3,.7,.2,1); }
.b3d:hover .b3d-book { transform: rotateY(-24deg); }
.b3d-face { position: absolute; left: 50%; top: 50%; backface-visibility: hidden; }
.b3d-front { background-color: var(--b3d-cover); background-size: 100% 100%; overflow: hidden; }
.b3d-front::after { content: ""; position: absolute; inset: 0;
  background: linear-gradient(105deg, rgba(255,255,255,0) 35%, rgba(255,255,255,.16) 48%, rgba(255,255,255,0) 62%); }
.b3d-hard .b3d-front::before { content: ""; position: absolute; top: 0; bottom: 0; left: 4.5%; width: 2.2%; z-index: 1;
  background: linear-gradient(90deg, rgba(0,0,0,.28), rgba(255,255,255,.18) 45%, rgba(0,0,0,.12)); }
.b3d-front .b3d-title { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center;
  padding: 14%; color: var(--b3d-ink, #fff); font: 600 var(--b3d-fs) / 1.25 "Inter", system-ui, sans-serif; }
.b3d-back { background: var(--b3d-cover); filter: brightness(.8); }
.b3d-spine { background: linear-gradient(90deg, var(--b3d-spine-dark), var(--b3d-cover) 35%, var(--b3d-spine-light) 55%, var(--b3d-cover) 75%, var(--b3d-spine-dark)); }
.b3d-mag .b3d-spine { background: linear-gradient(90deg, var(--b3d-spine-dark), var(--b3d-spine-light) 50%, var(--b3d-spine-dark)); }
.b3d-spine .b3d-staple { position: absolute; left: 50%; width: 1.5px; height: 9%; margin-left: -.75px; border-radius: 1px;
  background: linear-gradient(90deg, #8d9196, #eef0f2, #9aa0a6); }
.b3d-pages { background: linear-gradient(180deg, rgba(0,0,0,.06), rgba(0,0,0,0) 20%, rgba(0,0,0,0) 80%, rgba(0,0,0,.08)),
  repeating-linear-gradient(90deg, #fbf9f4 0 1px, #dcd6c8 1px 2px); box-shadow: inset 0 0 3px rgba(0,0,0,.28); }
.b3d-inner { background: var(--b3d-spine-dark); filter: brightness(.85); }
.b3d-fore { background: linear-gradient(90deg, var(--b3d-spine-dark) 0 var(--b3d-board), transparent var(--b3d-board) calc(100% - var(--b3d-board)), var(--b3d-spine-dark) calc(100% - var(--b3d-board))); }
.b3d-top { background: repeating-linear-gradient(0deg, #f6f3ec 0 1px, #e1dccf 1px 2px); box-shadow: inset 0 0 2px rgba(0,0,0,.25); }
`;

function injectCss() {
  if (document.getElementById('b3d-css')) return;
  const style = document.createElement('style');
  style.id = 'b3d-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('');
}

/**
 * Tekent een 3D-boek in `el`.
 * opts: { coverUrl, title, widthMm, heightMm, pages, binding, coverColor, paperMm, boxWidth, boxHeight }
 */
export function renderBook3D(el, opts) {
  injectCss();
  const binding = BINDINGS[opts.binding] ? opts.binding : 'hardcover';
  const b = BINDINGS[binding];
  const wMm = opts.widthMm || 210, hMm = opts.heightMm || 297;
  const ovMm = b.overhangMm;
  const tMm = spineMm(binding, opts.pages || 40, opts.paperMm);
  // Kaft is bij hardcover groter dan het papierblok (overstek aan boven-, onder- en voorkant).
  const coverW = wMm + ovMm, coverH = hMm + 2 * ovMm;
  const boxW = opts.boxWidth || 150, boxH = opts.boxHeight || 190;
  const k = Math.min((boxW * 0.78) / (coverW + tMm * 0.6), (boxH * 0.86) / coverH);
  const W = coverW * k, H = coverH * k, T = Math.max(2, tMm * k);
  const ov = ovMm * k, board = Math.min(T / 3, b.coverMm * k);
  const color = /^#[0-9a-f]{6}$/i.test(opts.coverColor || '') ? opts.coverColor : '#f3f1ec';

  el.innerHTML = '';
  el.classList.add('b3d', binding === 'hardcover' ? 'b3d-hard' : binding === 'magazine' ? 'b3d-mag' : 'b3d-soft');
  el.style.width = boxW + 'px';
  el.style.height = boxH + 'px';
  el.style.setProperty('--b3d-cover', color);
  const n = parseInt(color.slice(1), 16);
  el.style.setProperty('--b3d-ink', (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 > 0.6 ? '#1d2430' : '#fff');
  el.style.setProperty('--b3d-spine-dark', shade(color, -0.35));
  el.style.setProperty('--b3d-spine-light', shade(color, 0.18));
  el.style.setProperty('--b3d-fs', Math.max(8, W / 11) + 'px');
  el.title = `${b.label} · ${Math.round(wMm)} × ${Math.round(hMm)} mm · rug ca. ${tMm.toFixed(1).replace('.', ',')} mm`;

  const shadow = document.createElement('div');
  shadow.className = 'b3d-shadow';
  const book = document.createElement('div');
  book.className = 'b3d-book';
  book.style.width = W + 'px';
  book.style.height = H + 'px';

  const face = (cls, w, h, transform) => {
    const f = document.createElement('div');
    f.className = 'b3d-face ' + cls;
    f.style.width = w + 'px';
    f.style.height = h + 'px';
    f.style.marginLeft = -w / 2 + 'px';
    f.style.marginTop = -h / 2 + 'px';
    f.style.transform = transform;
    book.appendChild(f);
    return f;
  };

  const front = face('b3d-front', W, H, `translateZ(${T / 2}px)`);
  if (opts.coverUrl) front.style.backgroundImage = `url("${opts.coverUrl}")`;
  else {
    const t = document.createElement('div');
    t.className = 'b3d-title';
    t.textContent = opts.title || '';
    front.appendChild(t);
  }
  face('b3d-back', W, H, `rotateY(180deg) translateZ(${T / 2}px)`);
  const spine = face('b3d-spine', T, H, `rotateY(-90deg) translateZ(${W / 2}px)`);
  if (binding === 'magazine') {
    for (const top of ['26%', '65%']) {
      const s = document.createElement('i');
      s.className = 'b3d-staple';
      s.style.top = top;
      spine.appendChild(s);
    }
  }
  // Papierblok: tussen de kaften, bij hardcover iets kleiner dan de kaft.
  const blockT = Math.max(1, T - 2 * board);
  face('b3d-pages', blockT, H - 2 * ov, `rotateY(90deg) translateZ(${W / 2 - ov}px)`);
  if (ov > 0) {
    // Randen van de kartonnen kaften aan de voorsnede, met het papierblok iets naar binnen.
    const fore = face('b3d-fore', T, H, `rotateY(90deg) translateZ(${W / 2}px)`);
    fore.style.setProperty('--b3d-board', board + 'px');
    // Binnenkant van de achterkaft, zichtbaar in de overstek naast het papier.
    face('b3d-inner', ov, H, `translateX(${W / 2 - ov / 2}px) translateZ(${-T / 2 + board}px)`);
  }
  face('b3d-top', W - ov, blockT, `translateX(${-ov / 2}px) rotateX(90deg) translateZ(${H / 2 - ov}px)`);

  el.append(shadow, book);
  return { spineMm: tMm };
}

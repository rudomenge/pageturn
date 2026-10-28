// Bladerboek: kleine server voor het delen van PDF-boeken met klanten.
// Opslag is bewust simpel: per boek een map in DATA_DIR met book.pdf, meta.json en comments.json.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const BINDINGS = ['hardcover', 'softcover', 'magazine'];
const COVER_MODES = ['outer', 'full', 'none'];

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!process.env.ADMIN_PASSWORD) {
  console.warn('Let op: ADMIN_PASSWORD is niet ingesteld, het beheerwachtwoord is "admin".');
}

const app = express();
app.use(express.json({ limit: '200kb' }));

const bookDir = (id) => path.join(DATA_DIR, 'books', id);
const validId = (id) => /^[a-z0-9]{10,32}$/.test(id);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function readJsonString(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function writeJson(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function loadBook(id) {
  if (!validId(id)) return null;
  const meta = readJson(path.join(bookDir(id), 'meta.json'), null);
  return meta && fs.existsSync(path.join(bookDir(id), 'book.pdf')) ? meta : null;
}
function publicMeta(meta) {
  const { id, title, binding, coverColor, coverMode, allowDownload, allowComments, allowBindingSwitch, pageCount, trim, pageSize, coverVersion, createdAt } = meta;
  return { id, title, binding, coverColor, coverMode, allowDownload, allowComments, allowBindingSwitch, pageCount, trim, pageSize, coverVersion, createdAt };
}
function cleanSettings(body, meta) {
  const out = {};
  if (typeof body.title === 'string') out.title = body.title.trim().slice(0, 200) || meta.title;
  if (BINDINGS.includes(body.binding)) out.binding = body.binding;
  if (typeof body.coverColor === 'string' && /^(#[0-9a-f]{6}|auto)$/i.test(body.coverColor)) out.coverColor = body.coverColor;
  if (COVER_MODES.includes(body.coverMode)) out.coverMode = body.coverMode;
  let ps = body.pageSize;
  if (typeof ps === 'string') ps = readJsonString(ps);
  if (ps && [ps.widthMm, ps.heightMm].every((v) => Number.isFinite(+v) && +v >= 10 && +v <= 2000)) {
    out.pageSize = { widthMm: Math.round(+ps.widthMm * 10) / 10, heightMm: Math.round(+ps.heightMm * 10) / 10 };
  }
  for (const k of ['allowDownload', 'allowComments', 'allowBindingSwitch']) {
    if (k in body) out[k] = body[k] === true || body[k] === 'true' || body[k] === 'on';
  }
  return out;
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, value] = header.split(' ');
  if (scheme === 'Basic' && value) {
    const pass = Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Bladerboek beheer", charset="UTF-8"');
  res.status(401).send('Inloggen vereist');
}

// ---- Beheer ----
app.get(['/', '/admin', '/admin.html'], requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/admin/books', requireAdmin, (req, res) => {
  const root = path.join(DATA_DIR, 'books');
  const ids = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const books = ids.map(loadBook).filter(Boolean).map((meta) => {
    const comments = readJson(path.join(bookDir(meta.id), 'comments.json'), []);
    return { ...meta, commentCount: comments.length, openCount: comments.filter((c) => !c.resolved).length };
  });
  books.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(books);
});

// Leest paginatal en de TrimBox (snijmaat zonder afloop) van de eerste pagina.
async function inspectPdf(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file), { updateMetadata: false, ignoreEncryption: true });
  const page = doc.getPage(0);
  const crop = page.getCropBox(), trim = page.getTrimBox();
  const inset = {
    left: trim.x - crop.x,
    bottom: trim.y - crop.y,
    right: crop.x + crop.width - (trim.x + trim.width),
    top: crop.y + crop.height - (trim.y + trim.height),
  };
  const sane = Object.values(inset).every((v) => v >= 0 && v < Math.min(crop.width, crop.height) / 4);
  const hasBleed = Object.values(inset).reduce((a, b) => a + b, 0) > 0.5;
  return { pageCount: doc.getPageCount(), trim: sane && hasBleed ? inset : null };
}

// Upload: het PDF-bestand is de body, de instellingen staan in de querystring (zelfde API als de Cloudflare-versie).
app.put('/api/admin/books', requireAdmin, async (req, res) => {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = bookDir(id);
  const file = path.join(dir, 'book.pdf');
  fs.mkdirSync(dir, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 300 * 1024 * 1024) { req.destroy(); reject(new Error('Bestand te groot')); }
      });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    return res.status(400).json({ error: e.message });
  }
  let info;
  try {
    info = await inspectPdf(file);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    return res.status(400).json({ error: 'Dit bestand is geen leesbare PDF' });
  }
  const q = req.query;
  const fileName = String(q.fileName || 'boek.pdf').slice(0, 200);
  const meta = {
    id,
    title: fileName.replace(/\.pdf$/i, ''),
    fileName,
    size: fs.statSync(file).size,
    pageCount: info.pageCount,
    trim: info.trim,
    binding: 'hardcover',
    coverColor: 'auto',
    coverMode: 'outer',
    allowDownload: true,
    allowComments: true,
    allowBindingSwitch: true,
    createdAt: new Date().toISOString(),
  };
  Object.assign(meta, cleanSettings(q, meta));
  writeJson(path.join(dir, 'meta.json'), meta);
  writeJson(path.join(dir, 'comments.json'), []);
  res.json(meta);
});

app.patch('/api/admin/books/:id', requireAdmin, (req, res) => {
  const meta = loadBook(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Boek niet gevonden' });
  Object.assign(meta, cleanSettings(req.body || {}, meta));
  writeJson(path.join(bookDir(meta.id), 'meta.json'), meta);
  res.json(meta);
});

app.delete('/api/admin/books/:id', requireAdmin, (req, res) => {
  if (!loadBook(req.params.id)) return res.status(404).json({ error: 'Boek niet gevonden' });
  fs.rmSync(bookDir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.patch('/api/admin/books/:id/comments/:cid', requireAdmin, (req, res) => {
  const file = path.join(bookDir(req.params.id), 'comments.json');
  if (!loadBook(req.params.id)) return res.status(404).json({ error: 'Boek niet gevonden' });
  const comments = readJson(file, []);
  const c = comments.find((x) => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Opmerking niet gevonden' });
  if ('resolved' in req.body) c.resolved = !!req.body.resolved;
  writeJson(file, comments);
  res.json(c);
});

app.delete('/api/admin/books/:id/comments/:cid', requireAdmin, (req, res) => {
  const file = path.join(bookDir(req.params.id), 'comments.json');
  if (!loadBook(req.params.id)) return res.status(404).json({ error: 'Boek niet gevonden' });
  writeJson(file, readJson(file, []).filter((x) => x.id !== req.params.cid));
  res.json({ ok: true });
});

// ---- Klant (via deellink) ----
app.get('/b/:id([a-z0-9]{10,32})', (req, res) => {
  if (!loadBook(req.params.id)) return res.status(404).send('Dit boek bestaat niet (meer).');
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/api/books/:id', (req, res) => {
  const meta = loadBook(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Boek niet gevonden' });
  res.json(publicMeta(meta));
});

app.get('/api/books/:id/pdf', (req, res) => {
  const meta = loadBook(req.params.id);
  if (!meta) return res.status(404).end();
  const download = req.query.download === '1';
  if (download && !meta.allowDownload) return res.status(403).send('Downloaden staat uit voor dit boek.');
  const name = (meta.title || 'boek').replace(/[^\w\- .]/g, '_') + '.pdf';
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`);
  res.sendFile(path.join(bookDir(meta.id), 'book.pdf'));
});

app.get('/api/books/:id/comments', (req, res) => {
  if (!loadBook(req.params.id)) return res.status(404).json({ error: 'Boek niet gevonden' });
  res.json(readJson(path.join(bookDir(req.params.id), 'comments.json'), []));
});

app.post('/api/books/:id/comments', (req, res) => {
  const meta = loadBook(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Boek niet gevonden' });
  if (!meta.allowComments) return res.status(403).json({ error: 'Opmerkingen staan uit' });
  const b = req.body || {};
  const text = String(b.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Lege opmerking' });
  const num = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
  const comment = {
    id: crypto.randomBytes(6).toString('hex'),
    author: String(b.author || '').trim().slice(0, 80) || 'Anoniem',
    text,
    page: Number.isInteger(b.page) && b.page > 0 ? b.page : null,
    x: num(b.x),
    y: num(b.y),
    resolved: false,
    createdAt: new Date().toISOString(),
  };
  const file = path.join(bookDir(meta.id), 'comments.json');
  const comments = readJson(file, []);
  if (comments.length >= 2000) return res.status(429).json({ error: 'Te veel opmerkingen' });
  comments.push(comment);
  writeJson(file, comments);
  res.json(comment);
});

// ---- Bekeken-registratie (zelfde API als de Cloudflare-versie) ----
const deviceOf = (ua = '') => (/iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobiel' : 'computer');
const viewsFile = (id) => path.join(bookDir(id), 'views.json');

// Voorkant als JPEG, gemaakt in de browser van de beheerder.
app.put('/api/admin/books/:id/cover', requireAdmin, express.raw({ type: ['image/jpeg', 'image/png'], limit: '3mb' }), (req, res) => {
  const meta = loadBook(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Boek niet gevonden' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Ongeldig plaatje' });
  fs.writeFileSync(path.join(bookDir(meta.id), 'cover.jpg'), req.body);
  meta.coverVersion = Date.now();
  writeJson(path.join(bookDir(meta.id), 'meta.json'), meta);
  res.json(meta);
});
app.get('/api/books/:id/cover', (req, res) => {
  const meta = loadBook(req.params.id);
  const file = meta && path.join(bookDir(meta.id), 'cover.jpg');
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Geen voorkant' });
  res.set('Cache-Control', 'public, max-age=300').type('image/jpeg').sendFile(file);
});

app.get('/api/admin/books/:id/views', requireAdmin, (req, res) => {
  if (!loadBook(req.params.id)) return res.status(404).json({ error: 'Boek niet gevonden' });
  res.json(readJson(viewsFile(req.params.id), []).slice().reverse().slice(0, 200));
});

app.post('/api/books/:id/views/:vid?', (req, res) => {
  if (!loadBook(req.params.id)) return res.status(404).json({ error: 'Boek niet gevonden' });
  const b = req.body || {};
  const maxPage = Number.isInteger(b.maxPage) && b.maxPage > 0 && b.maxPage < 10000 ? b.maxPage : 0;
  const seconds = Number.isFinite(b.seconds) ? Math.min(6 * 3600, Math.max(0, Math.round(b.seconds))) : 0;
  const views = readJson(viewsFile(req.params.id), []);
  if (!req.params.vid) {
    const startedAt = new Date().toISOString();
    const view = { id: `${startedAt}_${crypto.randomBytes(4).toString('hex')}`, startedAt, lastSeen: startedAt, seconds: 0, maxPage, device: deviceOf(req.headers['user-agent']), country: null, name: null };
    views.push(view);
    writeJson(viewsFile(req.params.id), views.slice(-5000));
    return res.json({ id: view.id });
  }
  const view = views.find((v) => v.id === req.params.vid);
  if (!view) return res.status(404).json({ error: 'Onbekend bezoek' });
  view.seconds = Math.max(view.seconds, seconds);
  view.maxPage = Math.max(view.maxPage, maxPage);
  view.lastSeen = new Date().toISOString();
  if (typeof b.name === 'string' && b.name.trim()) view.name = b.name.trim().slice(0, 80);
  writeJson(viewsFile(req.params.id), views);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// De viewer gebruikt relatieve paden, zodat hij ook onder /b/<id> zijn bestanden vindt.
app.use('/b', express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => console.log(`Bladerboek draait op http://localhost:${PORT}`));

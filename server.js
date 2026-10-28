// Bladerboek: kleine server voor het delen van PDF-boeken met klanten.
// Opslag is bewust simpel: per boek een map in DATA_DIR met book.pdf, meta.json en comments.json.
const express = require('express');
const multer = require('multer');
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
  const { id, title, binding, coverColor, coverMode, allowDownload, allowComments, allowBindingSwitch, pageCount, trim, createdAt } = meta;
  return { id, title, binding, coverColor, coverMode, allowDownload, allowComments, allowBindingSwitch, pageCount, trim, createdAt };
}
function cleanSettings(body, meta) {
  const out = {};
  if (typeof body.title === 'string') out.title = body.title.trim().slice(0, 200) || meta.title;
  if (BINDINGS.includes(body.binding)) out.binding = body.binding;
  if (typeof body.coverColor === 'string' && /^(#[0-9a-f]{6}|auto)$/i.test(body.coverColor)) out.coverColor = body.coverColor;
  if (COVER_MODES.includes(body.coverMode)) out.coverMode = body.coverMode;
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

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      req.bookId = crypto.randomBytes(8).toString('hex');
      const dir = bookDir(req.bookId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'book.pdf'),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)),
});

app.get('/health', (req, res) => res.send('ok'));

// ---- Beheer ----
app.get(['/', '/admin'], requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

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

app.post('/api/admin/books', requireAdmin, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen PDF ontvangen' });
  let info;
  try {
    info = await inspectPdf(req.file.path);
  } catch (e) {
    fs.rmSync(bookDir(req.bookId), { recursive: true, force: true });
    return res.status(400).json({ error: 'Dit bestand is geen leesbare PDF' });
  }
  const meta = {
    id: req.bookId,
    title: path.basename(req.file.originalname, path.extname(req.file.originalname)),
    fileName: req.file.originalname,
    size: req.file.size,
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
  Object.assign(meta, cleanSettings(req.body || {}, meta));
  writeJson(path.join(bookDir(meta.id), 'meta.json'), meta);
  writeJson(path.join(bookDir(meta.id), 'comments.json'), []);
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

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// De viewer gebruikt relatieve paden, zodat hij ook onder /b/<id> zijn bestanden vindt.
app.use('/b', express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => console.log(`Bladerboek draait op http://localhost:${PORT}`));

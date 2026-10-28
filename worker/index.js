// Bladerboek op Cloudflare: Worker met de statische bestanden (public/) als assets
// en alle boeken in één R2-bucket:
//   books/<id>/book.pdf
//   books/<id>/meta.json
//   books/<id>/comments/<tijdstip>_<cid>.json   (één object per opmerking, dus geen schrijfconflicten)
//   books/<id>/cover.pdf                          (losse omslag, optioneel)
//   books/<id>/endpaper.pdf                       (schutblad, optioneel)
//   books/<id>/cover.jpg                          (voorkant als plaatje voor de 3D-thumbnail)

const BINDINGS = ['hardcover', 'softcover', 'magazine'];
const COVER_MODES = ['outer', 'full', 'none'];
// Pdf-bestanden per boek: [bestandsnaam in R2, veld in meta.json]
const EXTRA_PDFS = { pdf: ['book.pdf', null], coverpdf: ['cover.pdf', 'coverPdf'], endpaperpdf: ['endpaper.pdf', 'endpaperPdf'] };
const MAX_COMMENTS = 1000; // R2 list geeft maximaal 1000 sleutels per keer

const validId = (id) => /^[a-z0-9]{10,32}$/.test(id);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const err = (status, error) => json({ error }, status);
const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

function publicMeta(meta) {
  const { id, title, binding, coverColor, coverMode, allowDownload, allowComments, allowBindingSwitch, pageCount, trim, pageSize, coverVersion, pdfVersion, coverPdf, endpaperPdf, paperGsm, paperType, headbandColor, createdAt } = meta;
  return { id, title, binding, coverColor, coverMode, allowDownload, allowComments, allowBindingSwitch, pageCount, trim, pageSize, coverVersion, pdfVersion, coverPdf, endpaperPdf, paperGsm, paperType, headbandColor, createdAt };
}

function cleanSettings(body, meta) {
  const out = {};
  if (typeof body.title === 'string') out.title = body.title.trim().slice(0, 200) || meta.title;
  if (BINDINGS.includes(body.binding)) out.binding = body.binding;
  if (typeof body.coverColor === 'string' && /^(#[0-9a-f]{6}|auto)$/i.test(body.coverColor)) out.coverColor = body.coverColor;
  if (COVER_MODES.includes(body.coverMode)) out.coverMode = body.coverMode;
  if (typeof body.headbandColor === 'string' && /^#[0-9a-f]{6}$/i.test(body.headbandColor)) out.headbandColor = body.headbandColor;
  const ps = typeof body.pageSize === 'string' ? safeJson(body.pageSize) : body.pageSize;
  if (ps && [ps.widthMm, ps.heightMm].every((v) => Number.isFinite(+v) && +v >= 10 && +v <= 2000)) {
    out.pageSize = { widthMm: Math.round(+ps.widthMm * 10) / 10, heightMm: Math.round(+ps.heightMm * 10) / 10 };
  }
  if ('paperGsm' in body) {
    const g = Number(body.paperGsm);
    out.paperGsm = body.paperGsm === null || body.paperGsm === '' ? null : Number.isFinite(g) && g >= 30 && g <= 500 ? Math.round(g) : meta.paperGsm ?? null;
  }
  if (['gloss', 'silk', 'uncoated', 'bulky'].includes(body.paperType)) out.paperType = body.paperType;
  for (const k of ['allowDownload', 'allowComments', 'allowBindingSwitch']) {
    if (k in body) out[k] = body[k] === true || body[k] === 'true' || body[k] === 'on';
  }
  return out;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Afloop zoals de beheerpagina hem in de browser heeft gemeten (in pt).
function cleanTrim(raw) {
  try {
    const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!t) return null;
    const out = {};
    for (const k of ['left', 'top', 'right', 'bottom']) {
      const v = Number(t[k]);
      if (!Number.isFinite(v) || v < 0 || v > 200) return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const [scheme, value] = (request.headers.get('Authorization') || '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  let decoded = '';
  try { decoded = new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))); } catch { return false; }
  return timingSafeEqual(decoded.split(':').slice(1).join(':'), env.ADMIN_PASSWORD);
}

function askLogin(env) {
  if (!env.ADMIN_PASSWORD) return new Response('Stel eerst het geheim ADMIN_PASSWORD in bij deze Worker.', { status: 503 });
  return new Response('Inloggen vereist', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Bladerboek beheer", charset="UTF-8"' },
  });
}

async function loadBook(env, id) {
  if (!validId(id)) return null;
  const obj = await env.BOOKS.get(`books/${id}/meta.json`);
  return obj ? obj.json() : null;
}

async function listComments(env, id) {
  const keys = [];
  let cursor;
  do {
    const page = await env.BOOKS.list({ prefix: `books/${id}/comments/`, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  keys.sort();
  const comments = await Promise.all(keys.map(async (k) => (await env.BOOKS.get(k))?.json()));
  return comments.filter(Boolean).map((c, i) => ({ ...c, _key: keys[i] }));
}

const stripKey = ({ _key, ...c }) => c;

// Bekeken-registratie: één object per bezoek, zonder IP-adres.
const VIEW_ID = /^\d{4}-\d\d-\d\dT[\d:.]+Z_[a-f0-9]{8}$/;
function deviceOf(ua = '') {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobiel';
  return 'computer';
}
async function listViews(env, id) {
  const keys = [];
  let cursor;
  do {
    const page = await env.BOOKS.list({ prefix: `books/${id}/views/`, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  keys.sort().reverse();
  return (await Promise.all(keys.slice(0, 200).map(async (k) => (await env.BOOKS.get(k))?.json()))).filter(Boolean);
}

async function deletePrefix(env, prefix) {
  let cursor;
  do {
    const page = await env.BOOKS.list({ prefix, cursor });
    if (page.objects.length) await env.BOOKS.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// PDF serveren met Range-ondersteuning, zodat pdf.js grote bestanden per stuk kan laden.
async function servePdf(request, env, meta, download, file = 'book.pdf') {
  const key = `books/${meta.id}/${file}`;
  const head = await env.BOOKS.head(key);
  if (!head) return err(404, 'PDF niet gevonden');
  const range = request.headers.get('Range');
  const obj = range ? await env.BOOKS.get(key, { range: request.headers }) : await env.BOOKS.get(key);
  if (!obj) return err(404, 'PDF niet gevonden');
  const name = (meta.title || 'boek').replace(/[^\w\- .]/g, '_') + (file === 'cover.pdf' ? ' omslag' : file === 'endpaper.pdf' ? ' schutblad' : '') + '.pdf';
  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
    'Cache-Control': 'private, max-age=3600',
    ETag: head.httpEtag,
  });
  if (range && obj.range) {
    const size = head.size;
    let start, end;
    if ('suffix' in obj.range) { start = size - obj.range.suffix; end = size - 1; }
    else { start = obj.range.offset ?? 0; end = obj.range.length != null ? start + obj.range.length - 1 : size - 1; }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(head.size));
  return new Response(obj.body, { status: 200, headers });
}

async function serveAsset(request, env, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  return env.ASSETS.fetch(new Request(url, request));
}

async function handle(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  let m;

  if (pathname === '/health') return new Response('ok');

  // ---- Beheer ----
  if (pathname === '/' || pathname === '/admin' || pathname === '/admin.html' || pathname.startsWith('/api/admin/')) {
    if (!isAdmin(request, env)) return askLogin(env);

    if (pathname === '/' || pathname === '/admin' || pathname === '/admin.html') return serveAsset(request, env, '/admin.html');

    if (pathname === '/api/admin/books' && method === 'GET') {
      const prefixes = [];
      let cursor;
      do {
        const page = await env.BOOKS.list({ prefix: 'books/', delimiter: '/', cursor });
        prefixes.push(...page.delimitedPrefixes);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      const books = (await Promise.all(prefixes.map((p) => loadBook(env, p.split('/')[1])))).filter(Boolean);
      books.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(books);
    }

    // Upload: het PDF-bestand is de body, de instellingen staan in de querystring.
    if (pathname === '/api/admin/books' && (method === 'PUT' || method === 'POST')) {
      const len = Number(request.headers.get('Content-Length') || 0);
      if (!request.body || !len) return err(400, 'Geen PDF ontvangen');
      const q = Object.fromEntries(url.searchParams);
      const id = randomHex(8);
      const fileName = String(q.fileName || 'boek.pdf').slice(0, 200);
      await env.BOOKS.put(`books/${id}/book.pdf`, request.body, { httpMetadata: { contentType: 'application/pdf' } });
      const head = await env.BOOKS.head(`books/${id}/book.pdf`);
      const meta = {
        id,
        title: fileName.replace(/\.pdf$/i, ''),
        fileName,
        size: head ? head.size : len,
        pageCount: Number.isInteger(+q.pageCount) && +q.pageCount > 0 ? +q.pageCount : null,
        trim: cleanTrim(q.trim),
        binding: 'hardcover',
        coverColor: 'auto',
        coverMode: 'outer',
        allowDownload: true,
        allowComments: true,
        allowBindingSwitch: true,
        createdAt: new Date().toISOString(),
      };
      Object.assign(meta, cleanSettings(q, meta));
      await env.BOOKS.put(`books/${id}/meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
      return json(meta);
    }

    if ((m = pathname.match(/^\/api\/admin\/books\/([a-z0-9]+)$/))) {
      const meta = await loadBook(env, m[1]);
      if (!meta) return err(404, 'Boek niet gevonden');
      if (method === 'PATCH') {
        Object.assign(meta, cleanSettings(await request.json().catch(() => ({})), meta));
        await env.BOOKS.put(`books/${meta.id}/meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
        return json(meta);
      }
      if (method === 'DELETE') {
        await deletePrefix(env, `books/${meta.id}/`);
        return json({ ok: true });
      }
    }

    if ((m = pathname.match(/^\/api\/admin\/books\/([a-z0-9]+)\/comments\/([a-z0-9]+)$/))) {
      if (!(await loadBook(env, m[1]))) return err(404, 'Boek niet gevonden');
      const c = (await listComments(env, m[1])).find((x) => x.id === m[2]);
      if (!c) return err(404, 'Opmerking niet gevonden');
      if (method === 'PATCH') {
        const body = await request.json().catch(() => ({}));
        if ('resolved' in body) c.resolved = !!body.resolved;
        await env.BOOKS.put(c._key, JSON.stringify(stripKey(c)), { httpMetadata: { contentType: 'application/json' } });
        return json(stripKey(c));
      }
      if (method === 'DELETE') {
        await env.BOOKS.delete(c._key);
        return json({ ok: true });
      }
    }
    // Binnenwerk vervangen of een losse omslag/schutblad toevoegen. Deellink, opmerkingen en bezoeken blijven.
    if ((m = pathname.match(/^\/api\/admin\/books\/([a-z0-9]+)\/(pdf|coverpdf|endpaperpdf)$/)) && (method === 'PUT' || method === 'DELETE')) {
      const meta = await loadBook(env, m[1]);
      if (!meta) return err(404, 'Boek niet gevonden');
      const [file, field] = EXTRA_PDFS[m[2]];
      const key = `books/${meta.id}/${file}`;
      // De thumbnail wordt daarna opnieuw gemaakt door de beheerpagina.
      if (m[2] !== 'endpaperpdf') delete meta.coverVersion;
      if (method === 'DELETE') {
        if (!field) return err(405, 'Het binnenwerk kan alleen vervangen worden');
        await env.BOOKS.delete(key);
        delete meta[field];
      } else {
        const len = Number(request.headers.get('Content-Length') || 0);
        if (!request.body || !len) return err(400, 'Geen PDF ontvangen');
        const q = Object.fromEntries(url.searchParams);
        await env.BOOKS.put(key, request.body, { httpMetadata: { contentType: 'application/pdf' } });
        const head = await env.BOOKS.head(key);
        const pageCount = Number.isInteger(+q.pageCount) && +q.pageCount > 0 ? +q.pageCount : null;
        const fileName = String(q.fileName || 'boek.pdf').slice(0, 200);
        if (field) {
          meta[field] = { fileName, pageCount, trim: cleanTrim(q.trim), size: head ? head.size : len, version: Date.now() };
        } else {
          Object.assign(meta, { fileName, pageCount, trim: cleanTrim(q.trim), size: head ? head.size : len, pdfVersion: Date.now() });
          const ps = cleanSettings({ pageSize: q.pageSize }, meta).pageSize;
          if (ps) meta.pageSize = ps;
        }
      }
      await env.BOOKS.put(`books/${meta.id}/meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
      return json(meta);
    }

    // Voorkant als JPEG, gemaakt in de browser van de beheerder.
    if ((m = pathname.match(/^\/api\/admin\/books\/([a-z0-9]+)\/cover$/)) && method === 'PUT') {
      const meta = await loadBook(env, m[1]);
      if (!meta) return err(404, 'Boek niet gevonden');
      const len = Number(request.headers.get('Content-Length') || 0);
      if (!request.body || !len || len > 3_000_000) return err(400, 'Ongeldig plaatje');
      const type = request.headers.get('Content-Type') === 'image/png' ? 'image/png' : 'image/jpeg';
      await env.BOOKS.put(`books/${meta.id}/cover.jpg`, request.body, { httpMetadata: { contentType: type } });
      meta.coverVersion = Date.now();
      await env.BOOKS.put(`books/${meta.id}/meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
      return json(meta);
    }
    if ((m = pathname.match(/^\/api\/admin\/books\/([a-z0-9]+)\/views$/)) && method === 'GET') {
      if (!(await loadBook(env, m[1]))) return err(404, 'Boek niet gevonden');
      return json(await listViews(env, m[1]));
    }
    return err(404, 'Onbekend adres');
  }

  // Bezoek registreren (start) en bijwerken (hoe lang, tot welke pagina).
  if ((m = pathname.match(/^\/api\/books\/([a-z0-9]+)\/views(?:\/([^/]+))?$/)) && method === 'POST') {
    if (!(await loadBook(env, m[1]))) return err(404, 'Boek niet gevonden');
    const b = await request.json().catch(() => ({}));
    const maxPage = Number.isInteger(b.maxPage) && b.maxPage > 0 && b.maxPage < 10000 ? b.maxPage : 0;
    const seconds = Number.isFinite(b.seconds) ? Math.min(6 * 3600, Math.max(0, Math.round(b.seconds))) : 0;
    if (!m[2]) {
      const startedAt = new Date().toISOString();
      const view = {
        id: `${startedAt}_${randomHex(4)}`,
        startedAt,
        lastSeen: startedAt,
        seconds: 0,
        maxPage,
        device: deviceOf(request.headers.get('User-Agent') || ''),
        country: request.cf?.country || null,
        name: null,
      };
      await env.BOOKS.put(`books/${m[1]}/views/${view.id}.json`, JSON.stringify(view));
      return json({ id: view.id });
    }
    let vid = '';
    try { vid = decodeURIComponent(m[2]); } catch {}
    if (!VIEW_ID.test(vid)) return err(400, 'Onbekend bezoek');
    const key = `books/${m[1]}/views/${vid}.json`;
    const view = await (await env.BOOKS.get(key))?.json();
    if (!view) return err(404, 'Onbekend bezoek');
    view.seconds = Math.max(view.seconds, seconds);
    view.maxPage = Math.max(view.maxPage, maxPage);
    view.lastSeen = new Date().toISOString();
    if (typeof b.name === 'string' && b.name.trim()) view.name = b.name.trim().slice(0, 80);
    await env.BOOKS.put(key, JSON.stringify(view));
    return json({ ok: true });
  }

  // ---- Klant (via deellink) ----
  if ((m = pathname.match(/^\/b\/([a-z0-9]{10,32})\/?$/))) {
    if (!(await loadBook(env, m[1]))) return new Response('Dit boek bestaat niet (meer).', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return serveAsset(request, env, '/viewer.html');
  }
  // De viewer gebruikt relatieve paden, dus /b/viewer.css enz. komen uit public/.
  if (pathname.startsWith('/b/')) return serveAsset(request, env, pathname.slice(2));

  if ((m = pathname.match(/^\/api\/books\/([a-z0-9]+)\/cover$/)) && (method === 'GET' || method === 'HEAD')) {
    if (!validId(m[1])) return err(404, 'Geen voorkant');
    const obj = await env.BOOKS.get(`books/${m[1]}/cover.jpg`);
    if (!obj) return err(404, 'Geen voorkant');
    return new Response(method === 'HEAD' ? null : obj.body, {
      headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=300', ETag: obj.httpEtag },
    });
  }

  if ((m = pathname.match(/^\/api\/books\/([a-z0-9]+)\/(coverpdf|endpaperpdf)$/)) && (method === 'GET' || method === 'HEAD')) {
    const meta = await loadBook(env, m[1]);
    const [file, field] = EXTRA_PDFS[m[2]];
    if (!meta || !meta[field]) return err(404, 'Bestand niet gevonden');
    return servePdf(request, env, meta, false, file);
  }

  if ((m = pathname.match(/^\/api\/books\/([a-z0-9]+)(\/pdf|\/comments)?$/))) {
    const meta = await loadBook(env, m[1]);
    if (!meta) return err(404, 'Boek niet gevonden');
    if (!m[2] && method === 'GET') return json(publicMeta(meta));
    if (m[2] === '/pdf' && (method === 'GET' || method === 'HEAD')) {
      const download = url.searchParams.get('download') === '1';
      if (download && !meta.allowDownload) return new Response('Downloaden staat uit voor dit boek.', { status: 403 });
      return servePdf(request, env, meta, download);
    }
    if (m[2] === '/comments' && method === 'GET') return json((await listComments(env, meta.id)).map(stripKey));
    if (m[2] === '/comments' && method === 'POST') {
      if (!meta.allowComments) return err(403, 'Opmerkingen staan uit');
      const b = await request.json().catch(() => ({}));
      const text = String(b.text || '').trim().slice(0, 4000);
      if (!text) return err(400, 'Lege opmerking');
      const existing = await env.BOOKS.list({ prefix: `books/${meta.id}/comments/`, limit: MAX_COMMENTS });
      if (existing.truncated) return err(429, 'Te veel opmerkingen');
      const num = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
      const comment = {
        id: randomHex(6),
        author: String(b.author || '').trim().slice(0, 80) || 'Anoniem',
        text,
        page: Number.isInteger(b.page) && b.page > 0 ? b.page : null,
        x: num(b.x),
        y: num(b.y),
        resolved: false,
        createdAt: new Date().toISOString(),
      };
      await env.BOOKS.put(`books/${meta.id}/comments/${comment.createdAt}_${comment.id}.json`, JSON.stringify(comment), {
        httpMetadata: { contentType: 'application/json' },
      });
      return json(comment);
    }
    return err(405, 'Niet toegestaan');
  }

  // Overige statische bestanden (vendor, fonts, viewer.html voor losse probeerversie).
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      console.error(e);
      return err(500, 'Er ging iets mis op de server');
    }
  },
};

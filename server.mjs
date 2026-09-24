import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import Busboy from 'busboy';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const isProduction = process.env.NODE_ENV === 'production';
const ADMIN_EMAIL = 'arash.karamyar1385@gmail.com';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const OTP_TTL_MS = 1000 * 60 * 10;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'students.db');
const DIST_DIR = path.join(__dirname, 'dist');
const PUBLIC_DIR = path.join(__dirname, 'public');
const OTP_SECRET = process.env.OTP_SECRET || (isProduction ? '' : 'development-only-change-me');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('login','register')),
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email, purpose, consumed, expires_at);
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash, expires_at);
  CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_students_name ON students(normalized_name);
`);
try { db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''"); } catch (_) {}


function normalizeName(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[‌\u200c]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function normalizeDigits(value) {
  return String(value ?? '').replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/\s/g, '');
}
function cleanEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(email) { return /^\S+@\S+\.\S+$/.test(email) && email.length <= 254; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function otpHash(email, code) { return crypto.createHmac('sha256', OTP_SECRET).update(`${email}:${code}`).digest('hex'); }
function safeEqualHex(a, b) {
  const aa = Buffer.from(a, 'hex'); const bb = Buffer.from(b, 'hex');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + derived.toString('hex');
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = crypto.scryptSync(password, salt, 64);
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function randomId() { return crypto.randomUUID(); }
function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(data);
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(token) {
  return `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${isProduction ? '; Secure' : ''}`;
}
function clearSessionCookie() { return `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProduction ? '; Secure' : ''}`; }
function getUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hash(token), Date.now());
  return row || null;
}
function requireUser(req, res) {
  const user = getUser(req);
  if (!user) { json(res, 401, { error: 'برای این عملیات باید وارد حساب شوید.' }); return null; }
  return user;
}
function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'admin' || user.email !== ADMIN_EMAIL) { json(res, 403, { error: 'دسترسی مدیریت مجاز نیست.' }); return null; }
  return user;
}
async function readBody(req, limit = 1024 * 1024) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > limit) throw Object.assign(new Error('حجم درخواست بیش از حد مجاز است.'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
async function readJson(req, limit = 1024 * 1024) {
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('داده ارسالی معتبر نیست.'), { status: 400 }); }
}

const rate = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now(); const item = rate.get(key);
  if (!item || now - item.start >= windowMs) { rate.set(key, { start: now, count: 1 }); return true; }
  item.count += 1; return item.count <= limit;
}
setInterval(() => { const now = Date.now(); for (const [key, item] of rate) if (now - item.start > 60 * 60 * 1000) rate.delete(key); }, 15 * 60 * 1000).unref();


async function register(req, res) {
  const body = await readJson(req);
  const email = cleanEmail(body.email);
  const password = String(body.password || '');
  const name = normalizeName(body.name || '') || 'کاربر دانشجو';
  if (!validEmail(email)) return json(res, 400, { error: 'ایمیل معتبر وارد کنید.' });
  if (password.length < 6) return json(res, 400, { error: 'رمز عبور باید حداقل ۶ کاراکتر باشد.' });
  const ip = req.socket.remoteAddress || 'unknown';
  if (!rateLimit(`reg-ip:${ip}`, 10, 60 * 60 * 1000)) return json(res, 429, { error: 'درخواست‌های زیادی ارسال شده است. کمی بعد دوباره تلاش کنید.' });
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) return json(res, 409, { error: 'این ایمیل قبلاً ثبت شده است. وارد شوید.' });
  const role = email === ADMIN_EMAIL ? 'admin' : 'user';
  const id = randomId();
  const password_hash = hashPassword(password);
  const created_at = new Date().toISOString();
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, email, name, password_hash, role, created_at);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(hash(token), id, Date.now() + SESSION_TTL_MS, Date.now());
  json(res, 200, { user: { email, name, role } }, { 'Set-Cookie': sessionCookie(token) });
}

async function login(req, res) {
  const body = await readJson(req);
  const email = cleanEmail(body.email);
  const password = String(body.password || '');
  if (!validEmail(email) || !password) return json(res, 400, { error: 'ایمیل و رمز عبور را وارد کنید.' });
  const ip = req.socket.remoteAddress || 'unknown';
  if (!rateLimit(`login-ip:${ip}`, 20, 15 * 60 * 1000) || !rateLimit(`login-email:${email}`, 10, 15 * 60 * 1000))
    return json(res, 429, { error: 'تلاش‌های زیادی انجام شده. کمی بعد دوباره تلاش کنید.' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !verifyPassword(password, user.password_hash || '')) {
    return json(res, 401, { error: 'ایمیل یا رمز عبور نادرست است.' });
  }
  // promote admin if needed
  if (email === ADMIN_EMAIL && user.role !== 'admin') {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
    user.role = 'admin';
  }
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(hash(token), user.id, Date.now() + SESSION_TTL_MS, Date.now());
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  json(res, 200, { user: { email: user.email, name: user.name, role: user.role } }, { 'Set-Cookie': sessionCookie(token) });
}

function datasetsWithCounts() {
  return db.prepare(`SELECT d.id,d.name,COUNT(s.id) AS count FROM datasets d LEFT JOIN students s ON s.dataset_id=d.id GROUP BY d.id ORDER BY d.created_at DESC`).all().map(x => ({ ...x, count: Number(x.count) }));
}
function stats() {
  const students = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  return { students: Number(students), users: Number(users), datasets: datasetsWithCounts() };
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 3 } });
    let file = null; let fields = {}; let fileTooLarge = false;
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      if (name !== 'file') { stream.resume(); return; }
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('limit', () => { fileTooLarge = true; });
      stream.on('end', () => { file = { buffer: Buffer.concat(chunks), filename: info.filename }; });
    });
    bb.on('error', reject); bb.on('finish', () => resolve({ fields, file, fileTooLarge }));
    req.pipe(bb);
  });
}
function parseExcel(buffer, filename) {
  if (!/\.(xlsx|xls)$/i.test(filename || '')) throw new Error('فقط فایل XLS یا XLSX مجاز است.');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, dense: true });
  const first = workbook.SheetNames[0]; const sheet = first ? workbook.Sheets[first] : null;
  if (!sheet) throw new Error('فایل اکسل خالی است.');
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (data.length < 2) throw new Error('فایل اکسل دارای اطلاعات قابل ورود نیست.');
  const seen = new Set(); const rows = []; let invalid = 0; let duplicates = 0;
  for (const raw of data.slice(1)) {
    const row = Array.isArray(raw) ? raw : [];
    const studentId = normalizeDigits(String(row[0] ?? '')); const fullName = normalizeName(String(row[1] ?? ''));
    if (!/^\d{10}$/.test(studentId) || !fullName) { invalid++; continue; }
    if (seen.has(studentId)) { duplicates++; continue; }
    seen.add(studentId); rows.push({ studentId, fullName });
  }
  return { total: data.length - 1, valid: rows.length, invalid, duplicates, rows };
}

async function importExcel(req, res) {
  const admin = requireAdmin(req, res); if (!admin) return;
  const parsed = await parseMultipart(req);
  if (parsed.fileTooLarge) return json(res, 413, { error: 'حجم فایل بیشتر از ۵ مگابایت است.' });
  if (!parsed.file) return json(res, 400, { error: 'فایل اکسل ارسال نشده است.' });
  const datasetName = normalizeName(parsed.fields.datasetName || 'دانشجویان جدید').slice(0, 100);
  if (!datasetName) return json(res, 400, { error: 'نام مجموعه معتبر نیست.' });
  const mode = parsed.fields.mode === 'replace' ? 'replace' : 'merge';
  const result = parseExcel(parsed.file.buffer, parsed.file.filename);
  if (!result.valid) return json(res, 400, { error: 'هیچ ردیف معتبری برای ورود وجود ندارد.', preview: result });
  let dataset = db.prepare('SELECT * FROM datasets WHERE name=?').get(datasetName);
  const now = new Date().toISOString();
  const tx = db.createSession ? null : null;
  db.exec('BEGIN');
  try {
    if (!dataset) { dataset = { id: randomId(), name: datasetName }; db.prepare('INSERT INTO datasets(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(dataset.id, dataset.name, now, now); }
    if (mode === 'replace') db.prepare('DELETE FROM students WHERE dataset_id=?').run(dataset.id);
    const insert = db.prepare(`INSERT INTO students(id,student_id,full_name,normalized_name,dataset_id) VALUES(?,?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET full_name=excluded.full_name,normalized_name=excluded.normalized_name,dataset_id=excluded.dataset_id`);
    for (const row of result.rows) insert.run(randomId(), row.studentId, row.fullName, normalizeName(row.fullName), dataset.id);
    db.prepare('UPDATE datasets SET updated_at=? WHERE id=?').run(now, dataset.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  json(res, 200, { ok: true, imported: result.rows.length, stats: stats() });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method || 'GET';
  if (method !== 'GET' && req.headers.origin && req.headers.host && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return json(res, 403, { error: 'درخواست نامعتبر است.' });
  try {
    if (method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (method === 'GET' && url.pathname === '/api/auth/me') { const user = getUser(req); return json(res, 200, { user: user ? { email: user.email, name: user.name, role: user.role } : null }); }
    if (method === 'POST' && url.pathname === '/api/auth/register') return register(req, res);
    if (method === 'POST' && url.pathname === '/api/auth/login') return login(req, res);
    if (method === 'POST' && url.pathname === '/api/auth/logout') { const token = parseCookies(req).sid; if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() }); }
    if (method === 'GET' && url.pathname === '/api/search') {
      const mode = url.searchParams.get('mode') === 'name' ? 'name' : 'id'; const q = url.searchParams.get('q') || '';
      let rows = [];
      if (mode === 'id') { const id = normalizeDigits(q); if (!/^\d{10}$/.test(id)) return json(res, 400, { error: 'شماره دانشجویی باید دقیقاً ۱۰ رقم باشد.' }); rows = db.prepare('SELECT s.student_id AS studentId,s.full_name AS fullName,d.name AS dataset FROM students s JOIN datasets d ON d.id=s.dataset_id WHERE s.student_id=? LIMIT 20').all(id); }
      else { const name = normalizeName(q); if (!name) return json(res, 400, { error: 'نام را وارد کنید.' }); rows = db.prepare(`SELECT s.student_id AS studentId,s.full_name AS fullName,d.name AS dataset FROM students s JOIN datasets d ON d.id=s.dataset_id WHERE s.normalized_name LIKE ? ORDER BY s.full_name LIMIT 100`).all(`%${name}%`); }
      return json(res, 200, { results: rows });
    }
    if (method === 'GET' && url.pathname === '/api/admin/stats') { if (!requireAdmin(req, res)) return; return json(res, 200, stats()); }
    if (method === 'GET' && url.pathname === '/api/admin/users') { if (!requireAdmin(req, res)) return; return json(res, 200, { users: db.prepare('SELECT id,email,name,role,created_at AS registeredAt FROM users ORDER BY created_at DESC LIMIT 1000').all() }); }
    if (method === 'POST' && url.pathname === '/api/admin/import') return importExcel(req, res);
    if (method === 'POST' && url.pathname === '/api/admin/dataset-rename') {
      if (!requireAdmin(req, res)) return; const body = await readJson(req); const id = String(body.id || ''); const name = normalizeName(body.name || '').slice(0, 100);
      if (!id || !name) return json(res, 400, { error: 'نام معتبر نیست.' });
      try { db.prepare('UPDATE datasets SET name=?,updated_at=? WHERE id=?').run(name, new Date().toISOString(), id); } catch { return json(res, 409, { error: 'مجموعه‌ای با این نام وجود دارد.' }); }
      return json(res, 200, { ok: true, stats: stats() });
    }
    if (method === 'GET') {
      let requestedPath = '/';
      try { requestedPath = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'مسیر نامعتبر است.' }); }
      let file = path.resolve(DIST_DIR, requestedPath === '/' ? 'index.html' : `.${requestedPath}`);
      const distRoot = path.resolve(DIST_DIR);
      if (!(file === distRoot || file.startsWith(distRoot + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST_DIR, 'index.html');
      if (fs.existsSync(file)) { const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }; res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' https://api.resend.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'" }); return fs.createReadStream(file).pipe(res); }
    }
    json(res, 404, { error: 'مسیر پیدا نشد.' });
  } catch (error) { console.error(error); json(res, error.status || 500, { error: error.message || 'خطای داخلی سرور.' }); }
}

const server = http.createServer(route);
server.listen(PORT, HOST, () => console.log(`DaneshjooYab server listening on http://${HOST}:${PORT}`));
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

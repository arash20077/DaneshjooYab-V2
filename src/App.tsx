import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileSpreadsheet, LogIn, LogOut, Search, ShieldCheck, Upload, UsersRound, X } from 'lucide-react';

type Student = { studentId: string; fullName: string; dataset: string };
type ImportRow = { studentId: string; fullName: string };
type ImportPreview = { total: number; valid: number; invalid: number; duplicates: number; rows: ImportRow[]; issues: string[]; fileName: string; file: File };
type Account = { email: string; name: string; role: 'user' | 'admin' };
type Dataset = { id: string; name: string; count: number };
type AdminUser = { id: string; email: string; name: string; role: string; registeredAt: string };

const normalizeName = (value: string) => value.normalize('NFKC').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[‌\u200c]/g, ' ').replace(/\s+/g, ' ').trim();
const normalizeDigits = (value: string) => value.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/\s/g, '');

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'خطایی رخ داد.');
  return data as T;
}

function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'id' | 'name'>('id');
  const [results, setResults] = useState<Student[]>([]);
  const [searched, setSearched] = useState(false);
  const [message, setMessage] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [datasetName, setDatasetName] = useState('دانشجویان جدید');
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [datasetDrafts, setDatasetDrafts] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [copiedStudentId, setCopiedStudentId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const perPage = 20;

  useEffect(() => { api<{ user: Account | null }>('/api/auth/me').then(({ user }) => setAccount(user)).catch(() => setAccount(null)); }, []);

  const pages = Math.max(1, Math.ceil(results.length / perPage));
  const visibleResults = useMemo(() => results.slice((page - 1) * perPage, page * perPage), [results, page]);

  const doSearch = async (event: FormEvent) => {
    event.preventDefault(); setMessage(''); setPage(1);
    const normalized = mode === 'id' ? normalizeDigits(query) : normalizeName(query);
    if (mode === 'id' && !/^\d{10}$/.test(normalized)) { setSearched(false); setMessage('شماره دانشجویی باید دقیقاً ۱۰ رقم باشد'); return; }
    if (mode === 'name' && !normalized) { setSearched(false); setMessage('برای جستجو نام یا نام خانوادگی را وارد کنید'); return; }
    try { const data = await api<{ results: Student[] }>(`/api/search?mode=${mode}&q=${encodeURIComponent(normalized)}`); setResults(data.results); setSearched(true); }
    catch (e) { setSearched(false); setMessage((e as Error).message); }
  };

  const openAuth = (mode: 'login' | 'register') => { setAuthMode(mode); setPassword(''); setEmail(''); setName(''); setAgreed(false); setMessage(''); setAuthOpen(true); };

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault(); setMessage('');
    const cleaned = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(cleaned)) return setMessage('ایمیل معتبر وارد کنید.');
    if (password.length < 6) return setMessage('رمز عبور باید حداقل ۶ کاراکتر باشد.');
    if (authMode === 'register' && !agreed) return setMessage('برای ثبت‌نام باید با شرایط استفاده موافق باشید.');
    setAuthLoading(true);
    try {
      const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body: Record<string, string> = { email: cleaned, password };
      if (authMode === 'register') body.name = name.trim() || 'کاربر دانشجو';
      const data = await api<{ user: Account }>(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setAccount(data.user);
      setAuthOpen(false);
      setPassword('');
      setMessage(authMode === 'register' ? 'ثبت‌نام با موفقیت انجام شد.' : 'ورود موفق.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setAuthLoading(false);
    }
  };

  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); setAccount(null); setAdminOpen(false); };

  const loadAdmin = async () => {
    if (account?.role !== 'admin') return;
    try { const [s, u] = await Promise.all([api<{ datasets: Dataset[] }>('/api/admin/stats'), api<{ users: AdminUser[] }>('/api/admin/users')]); setDatasets(s.datasets); setUsers(u.users); setDatasetDrafts(Object.fromEntries(s.datasets.map(d => [d.name, d.name]))); setAdminOpen(true); }
    catch (e) { setMessage((e as Error).message); }
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    setMessage(''); setPreview(null);
    if (!/\.(xlsx|xls)$/i.test(file.name)) return setMessage('فقط فایل XLS یا XLSX مجاز است.');
    if (file.size > 5 * 1024 * 1024) return setMessage('حجم فایل بیشتر از ۵ مگابایت است.');
    try {
      const XLSX = await import('xlsx'); const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]]; if (!sheet) throw new Error('فایل اکسل خالی است.');
      const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' }); if (data.length < 2) throw new Error('فایل اکسل دارای اطلاعات قابل ورود نیست.');
      const seen = new Set<string>(); let invalid = 0; let duplicates = 0; const rows: ImportRow[] = [];
      for (const raw of data.slice(1)) { const row = Array.isArray(raw) ? raw : []; const studentId = normalizeDigits(String(row[0] ?? '')); const fullName = normalizeName(String(row[1] ?? '')); if (!/^\d{10}$/.test(studentId) || !fullName) { invalid++; continue; } if (seen.has(studentId)) { duplicates++; continue; } seen.add(studentId); rows.push({ studentId, fullName }); }
      setPreview({ total: data.length - 1, valid: rows.length, invalid, duplicates, rows, fileName: file.name, file, issues: [ ...(invalid ? ['ردیف‌های ناقص یا دارای شماره دانشجویی نامعتبر وارد نمی‌شوند.'] : []), ...(duplicates ? ['شماره‌های دانشجویی تکراری داخل فایل وارد نمی‌شوند.'] : []) ] });
    } catch (e) { setMessage((e as Error).message || 'خواندن فایل انجام نشد.'); }
  };

  const importRows = async (replace: boolean) => {
    if (!preview || importing) return; setImporting(true); setMessage('');
    try {
      const form = new FormData(); form.append('file', preview.file); form.append('datasetName', datasetName.trim() || 'دانشجویان جدید'); form.append('mode', replace ? 'replace' : 'merge');
      const data = await api<{ imported: number; stats: { datasets: Dataset[] } }>('/api/admin/import', { method: 'POST', body: form });
      setDatasets(data.stats.datasets); setPreview(null); setMessage(`${data.imported.toLocaleString('fa-IR')} دانشجو با موفقیت وارد پایگاه داده شد.`);
    } catch (e) { setMessage((e as Error).message); } finally { setImporting(false); }
  };

  const renameDataset = async (oldName: string) => {
    const dataset = datasets.find(d => d.name === oldName); const newName = normalizeName(datasetDrafts[oldName] || oldName); if (!dataset || !newName) return;
    try { const data = await api<{ stats: { datasets: Dataset[] } }>('/api/admin/dataset-rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: dataset.id, name: newName }) }); setDatasets(data.stats.datasets); setMessage('نام مجموعه با موفقیت ویرایش شد.'); }
    catch (e) { setMessage((e as Error).message); }
  };

  const copyStudentId = async (studentId: string) => { try { await navigator.clipboard.writeText(studentId); setCopiedStudentId(studentId); window.setTimeout(() => setCopiedStudentId(null), 2200); } catch { setMessage('کپی شماره دانشجویی انجام نشد.'); } };

  return <main className="min-h-screen bg-slate-50 text-slate-800">
    <header className="border-b border-slate-200 bg-white/95"><div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8"><div className="flex items-center gap-2"><div className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-white"><UsersRound size={21} /></div><div><p className="font-extrabold">دانشجو‌یاب</p><p className="text-xs text-slate-500">جستجوی سریع اطلاعات دانشجو</p></div></div><div className="flex items-center gap-2">{account?.role === 'admin' && <button onClick={loadAdmin} className="hidden min-h-11 items-center gap-2 rounded-xl border border-indigo-100 px-3 text-sm font-bold text-indigo-700 hover:bg-indigo-50 sm:flex"><ShieldCheck size={17} />مدیریت</button>}{account ? <button onClick={logout} aria-label="خروج از حساب" className="min-h-11 rounded-xl px-3 text-sm font-bold text-slate-600 hover:bg-slate-100"><LogOut size={18} /></button> : <button onClick={() => openAuth('login')} className="flex min-h-11 items-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-700"><LogIn size={17} />ورود</button>}</div></div></header>
    <section className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8"><div className="mx-auto max-w-3xl text-center"><h1 className="text-3xl font-black tracking-tight sm:text-5xl">پیدا کردن اطلاعات دانشجو، ساده و سریع</h1><p className="mt-4 leading-8 text-slate-500">شماره دانشجویی یا نام را جستجو کنید.</p><div className="mt-8 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-slate-100 sm:p-6"><div className="mb-4 flex justify-center gap-2"><button onClick={() => setMode('id')} className={`rounded-xl px-4 py-2 text-sm font-bold ${mode === 'id' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>شماره دانشجویی</button><button onClick={() => setMode('name')} className={`rounded-xl px-4 py-2 text-sm font-bold ${mode === 'name' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>نام و نام خانوادگی</button></div><form onSubmit={doSearch} className="flex flex-col gap-3 sm:flex-row"><input value={query} onChange={e => setQuery(e.target.value)} dir={mode === 'id' ? 'ltr' : 'rtl'} placeholder={mode === 'id' ? 'مثلاً 4011234567' : 'مثلاً آرش کرم‌یار'} className="min-h-13 flex-1 rounded-2xl border border-slate-200 px-4 outline-none focus:border-indigo-500" /><button className="flex min-h-13 items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-6 font-bold text-white hover:bg-indigo-700"><Search size={19} />جستجو</button></form>{message && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-800">{message}</p>}</div></div>
      {searched && <section className="mt-8 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-100"><div className="flex items-center justify-between"><h2 className="font-black">نتایج جستجو</h2><span className="text-sm text-slate-500">{results.length.toLocaleString('fa-IR')} نتیجه</span></div>{results.length === 0 ? <p className="mt-5 rounded-2xl bg-slate-50 p-6 text-center text-sm text-slate-500">نتیجه‌ای پیدا نشد.</p> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[520px] text-right text-sm"><thead className="border-b text-slate-500"><tr><th className="p-3">شماره دانشجویی</th><th className="p-3">نام</th><th className="p-3">مجموعه</th><th className="p-3"></th></tr></thead><tbody>{visibleResults.map(row => <tr key={`${row.studentId}-${row.dataset}`} className="border-b border-slate-100"><td dir="ltr" className="p-3 font-bold">{row.studentId}</td><td className="p-3">{row.fullName}</td><td className="p-3 text-slate-500">{row.dataset}</td><td className="p-3 text-left"><button onClick={() => copyStudentId(row.studentId)} className="text-xs font-bold text-indigo-700">{copiedStudentId === row.studentId ? 'کپی شد' : 'کپی شماره'}</button></td></tr>)}</tbody></table></div>}{results.length > perPage && <div className="mt-4 flex items-center justify-center gap-3"><button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="min-h-10 rounded-xl border px-4 disabled:opacity-40">قبلی</button><span className="text-sm">صفحه {page} از {pages}</span><button disabled={page === pages} onClick={() => setPage(p => p + 1)} className="min-h-10 rounded-xl border px-4 disabled:opacity-40">بعدی</button></div>}</section>}
    </section>
    <footer className="border-t border-slate-200 bg-white"><div className="mx-auto w-full max-w-6xl px-4 py-7 text-center text-sm leading-7 text-slate-500 sm:px-6 lg:px-8"><p>مالک وب‌سایت: آرش کرم‌یار</p><p>تمام حقوق این وب‌سایت متعلق به آرش کرم‌یار است.</p><p className="mt-1">این سامانه یک پروژه آموزشی و پژوهشی است.</p></div></footer>

    {authOpen && <div className="fixed inset-0 z-30 grid place-items-center bg-slate-950/35 p-4"><form onSubmit={submitAuth} className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl"><div className="flex items-center justify-between"><h2 className="text-xl font-black">{authMode === 'login' ? 'ورود به حساب' : 'ثبت‌نام'}</h2><button type="button" onClick={() => setAuthOpen(false)} aria-label="بستن" className="rounded-lg p-2 hover:bg-slate-100"><X /></button></div>
      <p className="mt-2 text-sm text-slate-500">{authMode === 'login' ? 'با ایمیل و رمز عبور وارد شوید.' : 'یک حساب جدید بسازید.'}</p>
      {authMode === 'register' && <label className="mt-5 block text-sm font-bold">نام نمایشی<input value={name} onChange={e => setName(e.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3" /></label>}
      <label className="mt-4 block text-sm font-bold">ایمیل<input type="email" value={email} onChange={e => setEmail(e.target.value)} dir="ltr" required className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3" /></label>
      <label className="mt-4 block text-sm font-bold">رمز عبور<input type="password" value={password} onChange={e => setPassword(e.target.value)} dir="ltr" required minLength={6} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3" placeholder="حداقل ۶ کاراکتر" /></label>
      {authMode === 'register' && <div className="mt-4 rounded-xl bg-slate-50 p-4 text-xs leading-6 text-slate-600"><p>این وب‌سایت پروژه‌ای آموزشی و پژوهشی است و سیستم رسمی دانشگاه نیست مگر صریحاً اعلام شود.</p><label className="mt-3 flex items-start gap-2 font-bold text-slate-700"><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} className="mt-1" />شرایط استفاده و قوانین سایت را مطالعه کرده‌ام و با آن موافقم.</label></div>}
      <button disabled={authLoading || (authMode === 'register' && !agreed)} className="mt-5 min-h-12 w-full rounded-xl bg-indigo-600 font-bold text-white disabled:opacity-40">{authLoading ? 'لطفاً صبر کنید...' : (authMode === 'login' ? 'ورود' : 'ثبت‌نام')}</button>
      <button type="button" onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setMessage(''); setPassword(''); }} className="mt-3 w-full text-center text-sm font-bold text-indigo-600">{authMode === 'login' ? 'حساب ندارید؟ ثبت‌نام کنید' : 'قبلاً ثبت‌نام کرده‌اید؟ وارد شوید'}</button>
      {message && <p className="mt-4 text-center text-sm text-rose-600">{message}</p>}
    </form></div>}

    {adminOpen && <div className="fixed inset-0 z-20 overflow-y-auto bg-slate-50"><div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6"><div className="flex items-center justify-between"><div><h2 className="text-2xl font-black">مدیریت</h2><p className="mt-1 text-sm text-slate-500">داده‌ها روی سرور نگهداری می‌شوند و فقط مدیر احراز‌شده می‌تواند آن‌ها را تغییر دهد.</p></div><button onClick={() => setAdminOpen(false)} className="min-h-11 rounded-xl border px-4 font-bold">بازگشت</button></div><div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3"><div className="rounded-2xl bg-white p-5"><p className="text-sm text-slate-500">کل دانشجویان</p><p className="mt-2 text-3xl font-black">{datasets.reduce((a, b) => a + b.count, 0).toLocaleString('fa-IR')}</p></div><div className="rounded-2xl bg-white p-5"><p className="text-sm text-slate-500">مجموعه‌های فعال</p><p className="mt-2 text-3xl font-black">{datasets.length.toLocaleString('fa-IR')}</p></div><div className="rounded-2xl bg-white p-5"><p className="text-sm text-slate-500">کاربران</p><p className="mt-2 text-3xl font-black">{users.length.toLocaleString('fa-IR')}</p></div></div>
      <section className="mt-6 rounded-3xl bg-white p-5 sm:p-7"><div className="flex items-center gap-2"><UsersRound className="text-indigo-600" /><h3 className="font-extrabold">کاربران ثبت‌نام‌شده</h3></div>{users.length === 0 ? <p className="mt-4 rounded-2xl bg-slate-50 p-5 text-sm text-slate-500">هنوز کاربری ثبت‌نام نکرده است.</p> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-right text-sm"><thead className="border-b text-slate-500"><tr><th className="p-3">نام</th><th className="p-3">ایمیل</th><th className="p-3">نقش</th><th className="p-3">تاریخ</th></tr></thead><tbody>{users.map(user => <tr key={user.id} className="border-b border-slate-100"><td className="p-3 font-bold">{user.name}</td><td dir="ltr" className="p-3 text-right">{user.email}</td><td className="p-3">{user.role === 'admin' ? <span className="rounded-full bg-indigo-50 px-2 py-1 text-xs font-bold text-indigo-700">مدیر</span> : 'کاربر'}</td><td className="p-3 text-slate-500">{new Date(user.registeredAt).toLocaleDateString('fa-IR')}</td></tr>)}</tbody></table></div>}</section>
      <section className="mt-6 rounded-3xl bg-white p-5 sm:p-7"><div className="flex items-center gap-2"><FileSpreadsheet className="text-indigo-600" /><h3 className="font-extrabold">مجموعه داده‌ها</h3></div>{datasets.length === 0 ? <p className="mt-4 rounded-2xl bg-slate-50 p-5 text-sm text-slate-500">هنوز مجموعه‌ای ایجاد نشده است.</p> : <div className="mt-4 space-y-3">{datasets.map(dataset => <div key={dataset.id} className="flex flex-col gap-3 rounded-2xl border border-slate-100 p-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="font-bold">{dataset.name}</p><p className="mt-1 text-sm text-slate-500">{dataset.count.toLocaleString('fa-IR')} دانشجو</p></div><input value={datasetDrafts[dataset.name] ?? dataset.name} onChange={e => setDatasetDrafts(current => ({ ...current, [dataset.name]: e.target.value }))} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 sm:max-w-xs" /><button onClick={() => renameDataset(dataset.name)} className="min-h-11 rounded-xl border border-indigo-100 px-4 text-sm font-bold text-indigo-700">ذخیره نام</button></div>)}</div>}</section>
      <section className="mt-6 rounded-3xl bg-white p-5 sm:p-7"><div className="flex items-center gap-2"><Upload className="text-indigo-600" /><h3 className="font-extrabold">ورود اطلاعات از اکسل</h3></div><p className="mt-2 text-sm leading-7 text-slate-500">فایل‌های XLS و XLSX با ستون اول «شماره دانشجویی» و ستون دوم «نام و نام خانوادگی». فایل ابتدا در مرورگر پیش‌نمایش می‌شود و هنگام ورود، سرور دوباره آن را اعتبارسنجی می‌کند.</p><div className="mt-5 flex flex-col gap-3 sm:flex-row"><input value={datasetName} onChange={e => setDatasetName(e.target.value)} placeholder="نام مجموعه داده" className="min-h-12 w-full rounded-xl border border-slate-200 px-3 sm:max-w-xs" /><label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 font-bold text-white hover:bg-indigo-700"><Upload size={18} />انتخاب فایل اکسل<input type="file" accept=".xlsx,.xls" onChange={chooseFile} className="hidden" /></label></div>{preview && <div className="mt-6 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">پیش‌نمایش {preview.fileName}</p><p className="mt-1 text-sm text-slate-600">کل: {preview.total.toLocaleString('fa-IR')} · معتبر: {preview.valid.toLocaleString('fa-IR')} · نامعتبر: {preview.invalid.toLocaleString('fa-IR')} · تکراری: {preview.duplicates.toLocaleString('fa-IR')}</p></div><CheckCircle2 className="text-emerald-600" /></div>{preview.issues.map(issue => <p key={issue} className="mt-3 text-sm text-amber-800">{issue}</p>)}<div className="mt-4 overflow-x-auto"><table className="w-full text-right text-sm"><thead><tr className="text-slate-500"><th className="p-2">شماره دانشجویی</th><th className="p-2">نام</th></tr></thead><tbody>{preview.rows.slice(0, 5).map(row => <tr key={row.studentId} className="border-t border-indigo-100"><td dir="ltr" className="p-2">{row.studentId}</td><td className="p-2">{row.fullName}</td></tr>)}</tbody></table></div><div className="mt-4 flex flex-wrap gap-2"><button disabled={importing || !preview.valid} onClick={() => importRows(false)} className="min-h-11 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white disabled:opacity-50">{importing ? 'در حال ورود...' : 'تأیید و ادغام'}</button><button disabled={importing || !preview.valid} onClick={() => importRows(true)} className="min-h-11 rounded-xl border border-rose-200 px-4 text-sm font-bold text-rose-700 disabled:opacity-50">تأیید و جایگزینی</button><button onClick={() => setPreview(null)} disabled={importing} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600">انصراف</button></div></div>}</section>
    </div></div>}
  </main>;
}
export default App;


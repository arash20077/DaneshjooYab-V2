import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clipboard, FileSpreadsheet, LogIn, LogOut, Search, ShieldCheck, Upload, UsersRound, X } from 'lucide-react';

type Student = { id: string; studentId: string; fullName: string; normalizedName: string; dataset: string };
type ImportRow = { studentId: string; fullName: string };
type ImportPreview = {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  rows: ImportRow[];
  issues: string[];
  fileName: string;
};
type Account = { email: string; name: string; isAdmin: boolean };
type RegisteredUser = Account & { id: string; registeredAt: string };

const SUPER_ADMIN = 'arash.karamyar1385@gmail.com';
const normalizeName = (value: string) => value
  .normalize('NFKC')
  .replace(/[يى]/g, 'ی')
  .replace(/ك/g, 'ک')
  .replace(/[‌\u200c]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const normalizeDigits = (value: string) => value
  .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
  .replace(/\s/g, '');

function readStored<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) as T : fallback;
  } catch {
    return fallback;
  }
}

function App() {
  const [students, setStudents] = useState<Student[]>(() => readStored<Student[]>('student-search-records', []));
  const [account, setAccount] = useState<Account | null>(() => readStored<Account | null>('student-search-account', null));
  const [registeredUsers, setRegisteredUsers] = useState<RegisteredUser[]>(() => readStored<RegisteredUser[]>('student-search-users', []));
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'id' | 'name'>('id');
  const [searched, setSearched] = useState(false);
  const [message, setMessage] = useState('');
  const [page, setPage] = useState(1);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [datasetName, setDatasetName] = useState('دانشجویان جدید');
  const [datasetDrafts, setDatasetDrafts] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [copiedStudentId, setCopiedStudentId] = useState<string | null>(null);
  const perPage = 20;

  useEffect(() => { localStorage.setItem('student-search-records', JSON.stringify(students)); }, [students]);
  useEffect(() => { localStorage.setItem('student-search-account', JSON.stringify(account)); }, [account]);
  useEffect(() => { localStorage.setItem('student-search-users', JSON.stringify(registeredUsers)); }, [registeredUsers]);

  const results = useMemo(() => {
    if (!searched) return [];
    if (mode === 'id') return students.filter((student) => student.studentId === normalizeDigits(query));
    const normalized = normalizeName(query);
    return normalized ? students.filter((student) => student.normalizedName.includes(normalized)) : [];
  }, [students, mode, query, searched]);
  const datasets = useMemo(() => Array.from(new Set(students.map((item) => item.dataset))).map((title) => ({ title, count: students.filter((student) => student.dataset === title).length })), [students]);
  const visibleResults = results.slice((page - 1) * perPage, page * perPage);
  const pages = Math.max(1, Math.ceil(results.length / perPage));

  const doSearch = (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    setPage(1);
    if (mode === 'id' && !/^\d{10}$/.test(normalizeDigits(query))) {
      setSearched(false);
      setMessage('شماره دانشجویی باید دقیقاً ۱۰ رقم باشد');
      return;
    }
    if (mode === 'name' && !normalizeName(query)) {
      setSearched(false);
      setMessage('برای جستجو نام یا نام خانوادگی را وارد کنید');
      return;
    }
    setSearched(true);
  };

  const handleAuth = (event: FormEvent) => {
    event.preventDefault();
    const cleaned = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(cleaned) || (authMode === 'register' && !agreed)) return;
    const nextAccount = { email: cleaned, name: name.trim() || 'کاربر دانشجو', isAdmin: cleaned === SUPER_ADMIN };
    if (authMode === 'register') {
      setRegisteredUsers((current) => current.some((user) => user.email === cleaned)
        ? current.map((user) => user.email === cleaned ? { ...user, ...nextAccount } : user)
        : [...current, { ...nextAccount, id: crypto.randomUUID(), registeredAt: new Date().toISOString() }]);
    }
    setAccount(nextAccount);
    setAuthOpen(false);
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setMessage('');
    setPreview(null);
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      setMessage('ساختار فایل اکسل صحیح نیست.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage('حجم فایل بیشتر از حد مجاز است.');
      return;
    }
    try {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
      if (!sheet) {
        setMessage('ساختار فایل اکسل صحیح نیست.');
        return;
      }
      const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
      if (data.length < 2) {
        setMessage('فایل اکسل دارای اطلاعات قابل ورود نیست.');
        return;
      }
      const rows = data.slice(1);
      const seen = new Set<string>();
      let invalid = 0;
      let duplicates = 0;
      const validRows: ImportRow[] = [];
      rows.forEach((row) => {
        const values = Array.isArray(row) ? row : [];
        const studentId = normalizeDigits(String(values[0] ?? ''));
        const fullName = normalizeName(String(values[1] ?? ''));
        if (!/^\d{10}$/.test(studentId) || !fullName) {
          invalid += 1;
          return;
        }
        if (seen.has(studentId)) {
          duplicates += 1;
          return;
        }
        seen.add(studentId);
        validRows.push({ studentId, fullName });
      });
      setPreview({
        total: rows.length, valid: validRows.length, invalid, duplicates, rows: validRows, fileName: file.name,
        issues: [
          ...(invalid > 0 ? ['ردیف‌های ناقص یا دارای شماره دانشجویی نامعتبر وارد نمی‌شوند.'] : []),
          ...(duplicates > 0 ? ['شماره‌های دانشجویی تکراری داخل فایل وارد نمی‌شوند.'] : []),
        ],
      });
    } catch (error) {
      console.error('Excel parse failed', error);
      setMessage('خواندن فایل انجام نشد. فایل اکسل را بررسی کنید.');
    }
  };

  const importRows = (replace: boolean) => {
    if (!preview || importing) return;
    if (preview.rows.length === 0) {
      setMessage('هیچ ردیف معتبری برای ورود وجود ندارد.');
      return;
    }
    setImporting(true);
    try {
      const activeDataset = datasetName.trim() || 'دانشجویان جدید';
      const incoming = preview.rows.map((row) => ({ id: crypto.randomUUID(), studentId: row.studentId, fullName: row.fullName, normalizedName: normalizeName(row.fullName), dataset: activeDataset }));
      setStudents((current) => {
        if (replace) return [...current.filter((student) => student.dataset !== activeDataset), ...incoming];
        const incomingIds = new Set(incoming.map((row) => row.studentId));
        return [...current.filter((student) => !incomingIds.has(student.studentId)), ...incoming];
      });
      setPreview(null);
      setMessage(`${preview.rows.length.toLocaleString('fa-IR')} دانشجو با موفقیت وارد شد.`);
    } catch (error) {
      console.error('Import failed', error);
      setMessage('ورود اطلاعات انجام نشد. فایل یا داده‌های آن را بررسی کنید.');
    } finally { setImporting(false); }
  };

  const renameDataset = (oldName: string) => {
    const newName = normalizeName(datasetDrafts[oldName] ?? oldName);
    if (!newName) return;
    if (newName !== oldName && datasets.some((dataset) => dataset.title === newName)) {
      setMessage('مجموعه‌ای با این نام وجود دارد. نام دیگری انتخاب کنید.');
      return;
    }
    setStudents((current) => current.map((student) => student.dataset === oldName ? { ...student, dataset: newName } : student));
    setDatasetDrafts((current) => ({ ...current, [newName]: newName }));
    setMessage('نام مجموعه با موفقیت ویرایش شد.');
  };

  const copyStudentId = async (studentId: string) => {
    try {
      await navigator.clipboard.writeText(studentId);
      setCopiedStudentId(studentId);
      window.setTimeout(() => setCopiedStudentId((current) => current === studentId ? null : current), 2200);
    } catch {
      setMessage('کپی شماره دانشجویی انجام نشد.');
    }
  };

  return <main className="min-h-screen bg-slate-50 text-slate-800">
    <header className="border-b border-slate-200 bg-white/95">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2"><div className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-white"><UsersRound size={21} /></div><div><p className="font-extrabold">دانشجو‌یاب</p><p className="text-xs text-slate-500">جستجوی سریع اطلاعات دانشجو</p></div></div>
        <div className="flex items-center gap-2">
          {account?.isAdmin && <button data-testid="admin-open" onClick={() => setAdminOpen(true)} className="hidden min-h-11 items-center gap-2 rounded-xl border border-indigo-100 px-3 text-sm font-bold text-indigo-700 hover:bg-indigo-50 sm:flex"><ShieldCheck size={17} />مدیریت</button>}
          {account ? <button data-testid="logout-button" onClick={() => setAccount(null)} aria-label="خروج از حساب" className="min-h-11 rounded-xl px-3 text-sm font-bold text-slate-600 hover:bg-slate-100"><LogOut size={18} /></button> : <button data-testid="login-button" onClick={() => { setAuthMode('login'); setAuthOpen(true); }} className="flex min-h-11 items-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-700"><LogIn size={17} />ورود</button>}
        </div>
      </div>
    </header>

    <section className="mx-auto w-full max-w-4xl px-4 pb-10 pt-12 sm:px-6 sm:pt-20">
      <div className="text-center"><span className="rounded-full bg-indigo-50 px-3 py-1 text-sm font-bold text-indigo-700">ساده، سریع و دانشجو‌محور</span><h1 className="mt-5 text-3xl font-black leading-relaxed text-slate-900 sm:text-5xl">دانشجوی مورد نظر خود را پیدا کنید</h1><p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-slate-500 sm:text-base">با شماره دانشجویی یا نام و نام خانوادگی، میان مجموعه‌داده‌های فعال جستجو کنید.</p></div>
      <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-7">
        <div className="mb-5 grid grid-cols-2 rounded-2xl bg-slate-100 p-1">
          <button data-testid="id-mode" onClick={() => { setMode('id'); setSearched(false); setMessage(''); }} className={`min-h-11 rounded-xl text-sm font-bold ${mode === 'id' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}>شماره دانشجویی</button>
          <button data-testid="name-mode" onClick={() => { setMode('name'); setSearched(false); setMessage(''); }} className={`min-h-11 rounded-xl text-sm font-bold ${mode === 'name' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}>نام و نام خانوادگی</button>
        </div>
        <form onSubmit={doSearch} className="flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="search-input">عبارت جستجو</label><input data-testid="search-input" id="search-input" value={query} onChange={(event) => setQuery(event.target.value)} inputMode={mode === 'id' ? 'numeric' : 'text'} dir={mode === 'id' ? 'ltr' : 'rtl'} placeholder={mode === 'id' ? 'مثال: ۱۴۰۰۱۲۳۴۵۶' : 'مثال: علی احمدی'} className="min-h-13 w-full rounded-2xl border border-slate-200 bg-white px-4 text-base outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" />
          <button data-testid="search-button" className="flex min-h-13 items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-7 font-bold text-white transition hover:bg-indigo-700 focus:ring-4 focus:ring-indigo-200"><Search size={19} />جستجو</button>
        </form>
        {message && <p data-testid="feedback-message" role="status" className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">{message}</p>}
      </div>

      {searched && <section data-testid="search-results" className="mt-6 rounded-3xl border border-slate-200 bg-white p-4 sm:p-6"><div className="mb-4 flex items-center justify-between"><h2 className="font-extrabold">نتایج جستجو</h2><span className="text-sm text-slate-500">{results.length.toLocaleString('fa-IR')} نتیجه</span></div>{results.length === 0 ? <div data-testid="empty-results" className="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500">{mode === 'id' ? 'دانشجویی با این شماره پیدا نشد' : 'دانشجویی با این مشخصات پیدا نشد'}</div> : <><div className="space-y-2">{visibleResults.map((student) => <article key={student.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 p-4"><div className="min-w-0"><h3 className="font-bold text-slate-900">{student.fullName}</h3><p className="mt-1 text-sm text-slate-500">مجموعه: {student.dataset}</p></div><div className="flex shrink-0 items-center gap-1"><span dir="ltr" className="rounded-lg bg-indigo-50 px-3 py-2 text-sm font-bold text-indigo-700">{student.studentId}</span><button data-testid={`copy-student-${student.studentId}`} onClick={() => copyStudentId(student.studentId)} className="grid size-10 place-items-center rounded-lg bg-indigo-50 text-indigo-700 transition hover:bg-indigo-100 focus:ring-4 focus:ring-indigo-100" aria-label={`کپی شماره دانشجویی ${student.studentId}`} title="کپی شماره دانشجویی"><Clipboard size={18} /></button>{copiedStudentId === student.studentId && <span data-testid="copy-success" role="status" className="absolute mt-16 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm">کپی شد</span>}</div></article>)}</div>{pages > 1 && <div className="mt-5 flex items-center justify-center gap-3"><button data-testid="previous-page" disabled={page === 1} onClick={() => setPage((value) => value - 1)} className="min-h-11 rounded-xl border px-4 disabled:opacity-40">بعدی</button><span className="text-sm">صفحه {page} از {pages}</span><button data-testid="next-page" disabled={page === pages} onClick={() => setPage((value) => value + 1)} className="min-h-11 rounded-xl border px-4 disabled:opacity-40">قبلی</button></div>}</>}</section>}
    </section>

    <footer className="border-t border-slate-200 bg-white"><div className="mx-auto w-full max-w-6xl px-4 py-7 text-center text-sm leading-7 text-slate-500 sm:px-6 lg:px-8"><p>مالک وب‌سایت: آرش کرم‌یار</p><p>تمام حقوق این وب‌سایت متعلق به آرش کرم‌یار است.</p><p className="mt-1">این سامانه یک پروژه آموزشی و پژوهشی است.</p></div></footer>

    {authOpen && <div className="fixed inset-0 z-20 grid place-items-center bg-slate-950/35 p-4"><form data-testid="auth-form" onSubmit={handleAuth} className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl"><div className="flex items-center justify-between"><h2 className="text-xl font-black">{authMode === 'login' ? 'ورود به حساب' : 'ثبت‌نام'}</h2><button type="button" onClick={() => setAuthOpen(false)} aria-label="بستن" className="rounded-lg p-2 hover:bg-slate-100"><X /></button></div><p className="mt-2 text-sm text-slate-500">{authMode === 'login' ? 'با ایمیل خود وارد شوید.' : 'برای استفاده از جستجو، حساب کاربری بسازید.'}</p>{authMode === 'register' && <label className="mt-5 block text-sm font-bold">نام نمایشی<input data-testid="name-input" value={name} onChange={(event) => setName(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3" /></label>}<label className="mt-4 block text-sm font-bold">ایمیل<input data-testid="email-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} dir="ltr" required className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3" /></label>{authMode === 'register' && <div className="mt-4 rounded-xl bg-slate-50 p-4 text-xs leading-6 text-slate-600"><p>این وب‌سایت پروژه‌ای آموزشی و پژوهشی است. داده‌ها ممکن است از فایل‌های منبع خطا داشته باشند و سامانه، سیستم رسمی دانشگاه محسوب نمی‌شود مگر صریحاً اعلام شود. استفاده مسئولانه الزامی است؛ بازنشر، برداشت خودکار و سوءاستفاده از اطلاعات ممنوع است و خدمت ممکن است تغییر یا متوقف شود.</p><label className="mt-3 flex items-start gap-2 font-bold text-slate-700"><input data-testid="terms-checkbox" type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className="mt-1" />شرایط استفاده و قوانین سایت را مطالعه کرده‌ام و با آن موافقم.</label></div>}<button data-testid="auth-submit" disabled={authMode === 'register' && !agreed} className="mt-5 min-h-12 w-full rounded-xl bg-indigo-600 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">{authMode === 'login' ? 'ورود' : 'تکمیل ثبت‌نام'}</button><button type="button" onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAgreed(false); }} className="mt-4 w-full text-sm font-bold text-indigo-700">{authMode === 'login' ? 'حساب ندارید؟ ثبت‌نام کنید' : 'حساب دارید؟ وارد شوید'}</button></form></div>}

    {adminOpen && <div className="fixed inset-0 z-20 overflow-y-auto bg-slate-50"><div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6"><div className="flex items-center justify-between"><div><h2 className="text-2xl font-black">مدیریت</h2><p className="mt-1 text-sm text-slate-500">مدیریت مجموعه‌ها، ورود اطلاعات و کاربران ثبت‌نام‌شده</p></div><button onClick={() => setAdminOpen(false)} className="min-h-11 rounded-xl border px-4 font-bold">بازگشت</button></div><div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3"><div className="rounded-2xl bg-white p-5"><p className="text-sm text-slate-500">کل دانشجویان</p><p className="mt-2 text-3xl font-black">{students.length.toLocaleString('fa-IR')}</p></div><div className="rounded-2xl bg-white p-5"><p className="text-sm text-slate-500">مجموعه‌های فعال</p><p className="mt-2 text-3xl font-black">{datasets.length.toLocaleString('fa-IR')}</p></div><div className="rounded-2xl bg-white p-5"><p className="text-sm text-slate-500">کاربران ثبت‌نام‌شده</p><p className="mt-2 text-3xl font-black">{registeredUsers.length.toLocaleString('fa-IR')}</p></div></div>

      <section className="mt-6 rounded-3xl bg-white p-5 sm:p-7"><div className="flex items-center gap-2"><UsersRound className="text-indigo-600" /><h3 className="font-extrabold">کاربران ثبت‌نام‌شده</h3></div><p className="mt-2 text-sm text-slate-500">فهرست افرادی که از مسیر ثبت‌نام، حساب ساخته‌اند.</p>{registeredUsers.length === 0 ? <p className="mt-4 rounded-2xl bg-slate-50 p-5 text-sm text-slate-500">هنوز کاربری ثبت‌نام نکرده است.</p> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-right text-sm"><thead className="border-b text-slate-500"><tr><th className="p-3">نام</th><th className="p-3">ایمیل</th><th className="p-3">نقش</th><th className="p-3">تاریخ ثبت‌نام</th></tr></thead><tbody>{registeredUsers.map((user) => <tr key={user.id} className="border-b border-slate-100"><td className="p-3 font-bold">{user.name}</td><td dir="ltr" className="p-3 text-right text-slate-600">{user.email}</td><td className="p-3">{user.isAdmin ? <span className="rounded-full bg-indigo-50 px-2 py-1 text-xs font-bold text-indigo-700">مدیر ارشد</span> : <span className="text-slate-600">کاربر</span>}</td><td className="p-3 text-slate-600">{new Date(user.registeredAt).toLocaleDateString('fa-IR')}</td></tr>)}</tbody></table></div>}</section>

      <section className="mt-6 rounded-3xl bg-white p-5 sm:p-7"><div className="flex items-center gap-2"><FileSpreadsheet className="text-indigo-600" /><h3 className="font-extrabold">مجموعه داده‌ها</h3></div><p className="mt-2 text-sm text-slate-500">نام هر مجموعه را در هر زمان تغییر دهید؛ اطلاعات دانشجویان آن مجموعه حفظ می‌شود.</p>{datasets.length === 0 ? <p className="mt-4 rounded-2xl bg-slate-50 p-5 text-sm text-slate-500">هنوز مجموعه‌ای ایجاد نشده است.</p> : <div className="mt-4 space-y-3">{datasets.map((dataset) => <div key={dataset.title} className="flex flex-col gap-3 rounded-2xl border border-slate-100 p-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="font-bold">{dataset.title}</p><p className="mt-1 text-sm text-slate-500">{dataset.count.toLocaleString('fa-IR')} دانشجو</p></div><label className="sr-only" htmlFor={`dataset-${dataset.title}`}>نام جدید مجموعه</label><input id={`dataset-${dataset.title}`} data-testid={`dataset-name-${dataset.title}`} value={datasetDrafts[dataset.title] ?? dataset.title} onChange={(event) => setDatasetDrafts((current) => ({ ...current, [dataset.title]: event.target.value }))} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 sm:max-w-xs" /><button data-testid={`save-dataset-${dataset.title}`} onClick={() => renameDataset(dataset.title)} className="min-h-11 rounded-xl border border-indigo-100 px-4 text-sm font-bold text-indigo-700 hover:bg-indigo-50">ذخیره نام</button></div>)}</div>}</section>

      <section className="mt-6 rounded-3xl bg-white p-5 sm:p-7"><div className="flex items-center gap-2"><Upload className="text-indigo-600" /><h3 className="font-extrabold">ورود اطلاعات از اکسل</h3></div><p className="mt-2 text-sm leading-7 text-slate-500">فایل‌های XLS و XLSX با ستون اول «شماره دانشجویی» و ستون دوم «نام و نام خانوادگی» را انتخاب کنید. ابتدا اعتبارسنجی و پیش‌نمایش انجام می‌شود.</p><div className="mt-5 flex flex-col gap-3 sm:flex-row"><input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} placeholder="نام مجموعه داده" className="min-h-12 w-full rounded-xl border border-slate-200 px-3 sm:max-w-xs" /><label data-testid="excel-upload" className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 font-bold text-white hover:bg-indigo-700"><Upload size={18} />انتخاب فایل اکسل<input type="file" accept=".xlsx,.xls" onChange={chooseFile} className="hidden" /></label></div>{preview && <div data-testid="import-preview" className="mt-6 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">پیش‌نمایش {preview.fileName}</p><p className="mt-1 text-sm text-slate-600">کل: {preview.total.toLocaleString('fa-IR')} · معتبر: {preview.valid.toLocaleString('fa-IR')} · نامعتبر: {preview.invalid.toLocaleString('fa-IR')} · تکراری: {preview.duplicates.toLocaleString('fa-IR')}</p></div><CheckCircle2 className="text-emerald-600" /></div>{preview.issues.map((issue) => <p key={issue} className="mt-3 text-sm text-amber-800">{issue}</p>)}<div className="mt-4 overflow-x-auto"><table className="w-full text-right text-sm"><thead><tr className="text-slate-500"><th className="p-2">شماره دانشجویی</th><th className="p-2">نام</th></tr></thead><tbody>{preview.rows.slice(0, 5).map((row) => <tr key={row.studentId} className="border-t border-indigo-100"><td dir="ltr" className="p-2">{row.studentId}</td><td className="p-2">{row.fullName}</td></tr>)}</tbody></table></div>{preview.valid > 5 && <p className="mt-2 text-xs text-slate-500">فقط ۵ ردیف اول نمایش داده شده است؛ با تأیید، همهٔ {preview.valid.toLocaleString('fa-IR')} ردیف معتبر وارد می‌شوند.</p>}<div className="mt-4 flex flex-wrap gap-2"><button data-testid="merge-import" disabled={importing || preview.valid === 0} onClick={() => importRows(false)} className="min-h-11 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">{importing ? 'در حال ورود...' : 'تأیید و ادغام'}</button><button data-testid="replace-import" disabled={importing || preview.valid === 0} onClick={() => importRows(true)} className="min-h-11 rounded-xl border border-rose-200 px-4 text-sm font-bold text-rose-700 disabled:cursor-not-allowed disabled:opacity-50">تأیید و جایگزینی</button><button onClick={() => setPreview(null)} disabled={importing} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600">انصراف</button></div></div>}</section>
    </div></div>}
  </main>;
}

export default App;

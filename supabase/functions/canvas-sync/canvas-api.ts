// 스마트캠퍼스(Canvas) REST API로 수강 과목의 과제와 내 제출 정보를 읽는다.
// 학생이 직접 만든 액세스 토큰을 쓴다. 결과 형식은 북마클릿(assets/js/canvas.js)과 같다.
//
// GET /api/v1/courses?enrollment_state=active|completed&enrollment_type=student&include[]=term
//   - 지금 듣는 과목 + 끝난 과목 중 최근 학기(약 9개월 안)만
// GET /api/v1/courses/:id/assignments?include[]=submission
//   - 첨부 파일은 이름과 크기만 남긴다 (다운로드 주소에는 인증 값이 붙어 있어서 저장하지 않음)
//   - submission.missing: 마감이 지났는데 내지 않은 과제 (Canvas가 판단, 면제된 과제 제외)
// GET /api/v1/announcements?context_codes[]=course_:id  (지금 듣는 과목의 최근 30일 공지)
// 강의 영상: learningx(LTI)의 학습 목록에서 기한이 있는 영상 · 자료를 '할 일'로 (아래 fetchLectures)
//   - 다 봤으면(completed) 완료

import type { CanvasItem } from "./ics.ts";

export type ApiItem = CanvasItem & {
  kind?: 'todo';
  missing?: boolean;
  submitted?: boolean;
  submittedAt?: string;
  submission?: { type: string | null; files: { name: string; size: number | null }[]; url?: string };
};

type Term = { start_at?: string | null; end_at?: string | null };
type Course = {
  id: number; name?: string; course_code?: string; term?: Term;
  start_at?: string | null; end_at?: string | null; created_at?: string | null;
};
type Attachment = { display_name?: string; filename?: string; size?: number };
type Submission = {
  submitted_at?: string | null; workflow_state?: string; submission_type?: string | null;
  attachments?: Attachment[]; url?: string | null; missing?: boolean; excused?: boolean;
};
type Assignment = {
  id: number; name?: string; due_at?: string | null; lock_at?: string | null; course_id?: number; submission?: Submission;
};

const courseName = (s?: string) => String(s ?? "").replace(/\s*\(\s*\d+\s*\)\s*$/, "").trim();
const clean = (s?: string) => String(s ?? "").replace(/\s+/g, " ").trim();

export class CanvasApiError extends Error {}

async function getAll<T>(url: string, token: string, limit = 20): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < limit; page++) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) throw new CanvasApiError("token_invalid");
    if (!res.ok) throw new CanvasApiError(`api_http_${res.status}`);
    const text = (await res.text()).replace(/^while\(1\);/, "");
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new CanvasApiError("api_unexpected");
    out.push(...data);
    next = (res.headers.get("Link") ?? "").match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return out;
}

function submissionInfo(sub?: Submission): Partial<ApiItem> {
  if (!sub) return {};
  const submitted = !!sub.submitted_at && sub.workflow_state !== "unsubmitted";
  if (!submitted) return { submitted: false, missing: sub.missing === true && sub.excused !== true };
  const files = (sub.attachments ?? []).slice(0, 20).map((a) => ({
    name: String(a.display_name || a.filename || "파일").slice(0, 120),
    size: typeof a.size === "number" ? a.size : null,
  }));
  const submission: ApiItem["submission"] = { type: sub.submission_type ?? null, files };
  if (sub.submission_type === "online_url" && sub.url) submission.url = String(sub.url).slice(0, 300);
  return { submitted: true, submittedAt: sub.submitted_at!, submission, missing: false };
}

// 끝난 과목은 최근 학기만 (오래된 학기까지 매번 읽지 않게)
const RECENT_MS = 270 * 864e5;
function isRecent(c: Course, now = Date.now()) {
  const ref = c.term?.end_at || c.end_at || c.term?.start_at || c.start_at || c.created_at;
  if (!ref) return false;
  return new Date(ref).getTime() >= now - RECENT_MS;
}

export async function fetchCourses(base: string, token: string) {
  const q = "enrollment_type=student&include[]=term&per_page=100";
  // 학교가 종료 처리를 안 해서 몇 년 전 과목이 "수강 중"으로 남아 있는 경우가 있어 날짜로 한 번 더 거른다
  const active = (await getAll<Course>(`${base}/api/v1/courses?enrollment_state=active&${q}`, token, 5))
    .filter((c) => isRecent(c) || !(c.term?.end_at || c.end_at || c.term?.start_at || c.start_at || c.created_at));
  let past: Course[] = [];
  try {
    past = (await getAll<Course>(`${base}/api/v1/courses?enrollment_state=completed&${q}`, token, 5))
      .filter((c) => isRecent(c) && !active.some((a) => a.id === c.id));
  } catch (e) {
    if (e instanceof CanvasApiError && e.message === "token_invalid") throw e;
  }
  return { active, past };
}

/* ───── 강의 영상 (learningx) ───── */
// 숭실대 스마트캠퍼스의 강의 영상은 Canvas 모듈이 아니라 learningx(LTI 도구) 안에 있다.
// 1) 모듈에서 learningx 항목 하나를 찾아 Canvas의 sessionless_launch(토큰으로 여는 LTI 실행)로 연다
// 2) learningx가 돌려주는 xn_api_token 쿠키로 과목별 주차 학습 목록(modules)을 읽는다
//    - 영상 항목(attendance_item)의 기한(due_at)과 다 봤는지(completed)를 쓴다
//    - 쿠키 값은 이번 실행 동안만 메모리에 두고 어디에도 저장하지 않는다
type ModuleItem = { id: number; type?: string; external_url?: string };
type Module = { id: number; items?: ModuleItem[] };
type LxItem = {
  module_item_id?: number; title?: string; content_type?: string; content_id?: number; completed?: boolean;
  content_data?: { due_at?: string | null; omit_progress?: boolean; item_content_type?: string } | null;
};

const decode = (v: string) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function learningxSession(base: string, token: string, courses: Course[]) {
  // learningx 항목 찾기
  let found: { course: number; item: number } | null = null;
  for (const c of courses) {
    let mods: Module[] = [];
    try { mods = await getAll<Module>(`${base}/api/v1/courses/${c.id}/modules?include[]=items&per_page=50`, token, 3); }
    catch (e) { if (e instanceof CanvasApiError && e.message === 'token_invalid') throw e; continue; }
    for (const m of mods) for (const it of m.items ?? [])
      if (!found && it.type === 'ExternalTool' && (it.external_url ?? '').includes('/learningx/')) found = { course: c.id, item: it.id };
    if (found) break;
  }
  if (!found) return null;
  const res = await fetch(`${base}/api/v1/courses/${found.course}/external_tools/sessionless_launch?launch_type=module_item&module_item_id=${found.item}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const launch = JSON.parse((await res.text()).replace(/^while\(1\);/, ''));
  if (typeof launch?.url !== 'string') return null;

  // 자동 제출 폼을 따라가며 쿠키를 모은다 (간단한 브라우저 흉내)
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let req: { url: string; method: string; body?: URLSearchParams } | null = { url: launch.url, method: 'GET' };
  for (let i = 0; i < 6 && req && !jar.has('xn_api_token'); i++) {
    const r: Response = await fetch(req.url, {
      method: req.method, body: req.body, redirect: 'manual',
      headers: { Cookie: cookie(), 'User-Agent': 'Mozilla/5.0 (dday-board-sync)' }, signal: AbortSignal.timeout(15000),
    });
    for (const sc of r.headers.getSetCookie()) {
      const kv = sc.split(';')[0]; const eq = kv.indexOf('=');
      if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1));
    }
    const loc = r.headers.get('location');
    if (loc) { await r.body?.cancel(); req = { url: new URL(loc, req.url).href, method: 'GET' }; continue; }
    const html = await r.text();
    const form = html.match(/<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
    if (!form) break;
    const body = new URLSearchParams();
    for (const inp of form[2].matchAll(/<input[^>]*>/gi)) {
      const n = inp[0].match(/name=["']([^"']+)/i)?.[1];
      if (n) body.set(n, decode(inp[0].match(/value=["']([^"']*)/i)?.[1] ?? ''));
    }
    req = { url: new URL(decode(form[1]), req.url).href, method: 'POST', body };
  }
  const xn = jar.get('xn_api_token');
  return xn ? { xn, cookie: cookie() } : null;
}

export async function fetchLectures(base: string, token: string, courses: Course[]): Promise<ApiItem[]> {
  const ses = await learningxSession(base, token, courses);
  if (!ses) return [];
  const out: ApiItem[] = [];
  const now = Date.now();
  for (const c of courses) {
    let items: LxItem[];
    try {
      const r = await fetch(`${base}/learningx/api/v1/courses/${c.id}/modules?include_detail=true`, {
        headers: { Authorization: `Bearer ${ses.xn}`, Accept: 'application/json', Cookie: ses.cookie }, signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) { await r.body?.cancel(); continue; }
      const d = JSON.parse(await r.text());
      if (!Array.isArray(d)) continue;
      items = d.flatMap((m: { module_items?: LxItem[] }) => Array.isArray(m?.module_items) ? m.module_items : []);
    } catch { continue; }
    for (const it of items) {
      const cd = it?.content_data ?? {};
      // 학습 목록에만 기한이 적힌 과제 · 퀴즈 (Canvas 과제 목록에서 못 찾은 것만 나중에 더함)
      if ((it?.content_type === 'assignment' || it?.content_type === 'quiz') && it.content_id) {
        const due = typeof cd.due_at === 'string' ? cd.due_at : null;
        const title = clean(it.title).slice(0, 200);
        if (!due || !title || Math.abs(new Date(due).getTime() - now) > 120 * 864e5) continue;
        out.push({
          id: it.content_type === 'assignment' ? `canvas-${it.content_id}` : `canvas-lxq${it.content_id}`,
          title,
          subject: courseName(c.name).slice(0, 40),
          due,
          link: it.module_item_id ? `${base}/courses/${c.id}/modules/items/${it.module_item_id}` : `${base}/courses/${c.id}/modules`,
          submitted: it.completed === true,
          missing: false,
        });
        continue;
      }
      // 강의 영상(학습 항목)
      if (it?.content_type !== 'attendance_item' || !it.content_id) continue;
      // 진도를 세지 않는 영상은 봤는지 알 수 없어서 넣지 않음
      if (cd.omit_progress === true) continue;
      const due = typeof cd.due_at === 'string' ? cd.due_at : null;
      if (!due || Math.abs(new Date(due).getTime() - now) > 120 * 864e5) continue;
      const title = clean(it.title).slice(0, 200);
      if (!title) continue;
      out.push({
        id: `canvas-lx${it.content_id}`,
        kind: 'todo',
        title,
        subject: courseName(c.name).slice(0, 40),
        due,
        link: it.module_item_id ? `${base}/courses/${c.id}/modules/items/${it.module_item_id}` : `${base}/courses/${c.id}/modules`,
        submitted: it.completed === true,
        missing: false,
      });
    }
  }
  return out;
}

export async function fetchCanvasApi(origin: string, token: string): Promise<{ items: ApiItem[]; active: Course[] }> {
  const base = origin.replace(/\/+$/, "");
  const { active, past } = await fetchCourses(base, token);

  const items = new Map<string, ApiItem>();
  for (const c of [...active, ...past]) {
    let list: Assignment[];
    try {
      list = await getAll<Assignment>(
        `${base}/api/v1/courses/${c.id}/assignments?include[]=submission&per_page=100`, token);
    } catch (e) {
      if (e instanceof CanvasApiError && e.message === "token_invalid") throw e;
      continue;   // 과제 목록을 막아 둔 과목은 건너뜀
    }
    for (const a of list) {
      // 마감이 없고 '이용 기간'만 정해 둔 과제는 닫히는 시각을 마감으로 본다
      const due = a?.due_at || (a?.lock_at && Date.parse(a.lock_at) > Date.now() ? a.lock_at : null);
      if (!a?.id || !due) continue;
      const title = clean(a.name).slice(0, 200);
      if (!title) continue;
      items.set(`canvas-${a.id}`, {
        id: `canvas-${a.id}`,
        title,
        subject: courseName(c.name).slice(0, 40),
        due,
        link: `${base}/courses/${c.id}/assignments/${a.id}`,
        ...submissionInfo(a.submission),
      });
    }
  }
  // 플래너: 나에게 적용되는 마감(반별 · 개인 연장 등 따로 정한 마감 포함). 과제 목록의 마감이 비었거나 다르면 이쪽을 따름
  try {
    const names = new Map([...active, ...past].map((c) => [c.id, courseName(c.name).slice(0, 40)]));
    for (const p of await fetchPlanner(base, token)) {
      const aid = p.plannable_type === "assignment" ? p.plannable_id : p.plannable?.assignment_id;
      if (!aid || !p.plannable_date || !p.course_id || !names.has(p.course_id)) continue;
      const id = `canvas-${aid}`;
      const cur = items.get(id);
      const sub = p.submissions || {};
      if (cur) { cur.due = p.plannable_date; continue; }
      const title = clean(p.plannable?.title).slice(0, 200);
      if (!title) continue;
      items.set(id, {
        id, title, subject: names.get(p.course_id)!, due: p.plannable_date,
        link: `${base}/courses/${p.course_id}/assignments/${aid}`,
        submitted: !!sub.submitted, missing: !!sub.missing && !sub.excused,
      });
    }
  } catch (e) {
    if (e instanceof CanvasApiError && e.message === "token_invalid") throw e;
    console.error("planner failed", e instanceof Error ? e.message : e);
  }
  // 강의 영상은 지금 듣는 과목만 (실패해도 과제는 그대로)
  try {
    const seen = new Set([...items.values()].map((v) => `${v.subject}|${v.title}`));
    for (const it of await fetchLectures(base, token, active)) {
      if (items.has(it.id)) continue;
      if (it.kind !== 'todo' && seen.has(`${it.subject}|${it.title}`)) continue;   // 퀴즈가 과제 목록에도 있으면 한 번만
      items.set(it.id, it);
    }
  } catch (e) {
    if (e instanceof CanvasApiError && e.message === 'token_invalid') throw e;
    console.error('lectures failed', e instanceof Error ? e.message : e);
  }
  return { items: [...items.values()], active };
}

/* ───── 플래너 (한 달 전 ~ 넉 달 뒤) ───── */
type PlannerItem = {
  plannable_id?: number; plannable_type?: string; plannable_date?: string | null; course_id?: number;
  plannable?: { title?: string; assignment_id?: number };
  submissions?: { submitted?: boolean; missing?: boolean; excused?: boolean } | false;
};
async function fetchPlanner(base: string, token: string): Promise<(PlannerItem & { submissions: { submitted?: boolean; missing?: boolean; excused?: boolean } })[]> {
  const day = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 10);
  const list = await getAll<PlannerItem>(
    `${base}/api/v1/planner/items?start_date=${day(-30 * 864e5)}&end_date=${day(120 * 864e5)}&per_page=100`, token, 10);
  return list
    .filter((p) => ["assignment", "quiz", "discussion_topic"].includes(p.plannable_type ?? ""))
    .map((p) => ({ ...p, submissions: p.submissions || {} }));
}

/* ───── 공지 ───── */
type Announcement = {
  id: number; title?: string; message?: string; posted_at?: string | null;
  html_url?: string; context_code?: string;
};
export type NoticeItem = { id: string; subject: string; title: string; preview: string; url: string | null; postedAt: string };

const stripHtml = (s?: string) => String(s ?? "")
  .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ").trim();

export async function fetchAnnouncements(origin: string, token: string, courses: Course[]): Promise<NoticeItem[]> {
  if (!courses.length) return [];
  const base = origin.replace(/\/+$/, "");
  const names = new Map(courses.map((c) => [`course_${c.id}`, courseName(c.name)]));
  const start = new Date(Date.now() - 30 * 864e5).toISOString();
  // end_date를 안 주면 Canvas가 start_date + 28일까지만 돌려줘서 최근 이틀 공지가 빠졌음
  const end = new Date(Date.now() + 864e5).toISOString();
  const out: NoticeItem[] = [];
  // 한 번에 너무 많은 과목을 넣지 않게 10개씩
  for (let i = 0; i < courses.length; i += 10) {
    const codes = courses.slice(i, i + 10).map((c) => `context_codes[]=course_${c.id}`).join("&");
    const list = await getAll<Announcement>(
      `${base}/api/v1/announcements?${codes}&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&per_page=50`, token, 3);
    for (const a of list) {
      if (!a?.id || !a.posted_at) continue;
      out.push({
        id: String(a.id),
        subject: (names.get(a.context_code ?? "") ?? "").slice(0, 40),
        title: clean(a.title).slice(0, 200) || "공지",
        preview: stripHtml(a.message).slice(0, 300),
        url: a.html_url ?? null,
        postedAt: a.posted_at,
      });
    }
  }
  return out;
}

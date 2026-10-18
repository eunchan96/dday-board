// 스마트캠퍼스(Canvas) REST API로 수강 과목의 과제와 내 제출 정보를 읽는다.
// 학생이 직접 만든 액세스 토큰을 쓴다. 결과 형식은 북마클릿(assets/js/canvas.js)과 같다.
//
// GET /api/v1/courses?enrollment_state=active|completed&enrollment_type=student&include[]=term
//   - 지금 듣는 과목 + 끝난 과목 중 최근 학기(약 9개월 안)만
// GET /api/v1/courses/:id/assignments?include[]=submission
//   - 첨부 파일은 이름과 크기만 남긴다 (다운로드 주소에는 인증 값이 붙어 있어서 저장하지 않음)
//   - submission.missing: 마감이 지났는데 내지 않은 과제 (Canvas가 판단, 면제된 과제 제외)
// GET /api/v1/announcements?context_codes[]=course_:id  (지금 듣는 과목의 최근 30일 공지)

import type { CanvasItem } from "./ics.ts";

export type ApiItem = CanvasItem & {
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
  id: number; name?: string; due_at?: string | null; course_id?: number; submission?: Submission;
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
      if (!a?.id || !a.due_at) continue;
      const title = clean(a.name).slice(0, 200);
      if (!title) continue;
      items.set(`canvas-${a.id}`, {
        id: `canvas-${a.id}`,
        title,
        subject: courseName(c.name).slice(0, 40),
        due: a.due_at,
        link: `${base}/courses/${c.id}/assignments/${a.id}`,
        ...submissionInfo(a.submission),
      });
    }
  }
  return { items: [...items.values()], active };
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
  const out: NoticeItem[] = [];
  // 한 번에 너무 많은 과목을 넣지 않게 10개씩
  for (let i = 0; i < courses.length; i += 10) {
    const codes = courses.slice(i, i + 10).map((c) => `context_codes[]=course_${c.id}`).join("&");
    const list = await getAll<Announcement>(
      `${base}/api/v1/announcements?${codes}&start_date=${encodeURIComponent(start)}&per_page=50`, token, 3);
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

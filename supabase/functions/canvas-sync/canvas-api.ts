// 스마트캠퍼스(Canvas) REST API로 수강 과목의 과제와 내 제출 정보를 읽는다.
// 학생이 직접 만든 액세스 토큰을 쓴다. 결과 형식은 북마클릿(assets/js/canvas.js)과 같다.
//
// GET /api/v1/courses?enrollment_state=active&enrollment_type=student
// GET /api/v1/courses/:id/assignments?include[]=submission
//   - 첨부 파일은 이름과 크기만 남긴다 (다운로드 주소에는 인증 값이 붙어 있어서 저장하지 않음)

import type { CanvasItem } from "./ics.ts";

export type ApiItem = CanvasItem & {
  submitted?: boolean;
  submittedAt?: string;
  submission?: { type: string | null; files: { name: string; size: number | null }[]; url?: string };
};

type Course = { id: number; name?: string; course_code?: string };
type Attachment = { display_name?: string; filename?: string; size?: number };
type Submission = {
  submitted_at?: string | null; workflow_state?: string; submission_type?: string | null;
  attachments?: Attachment[]; url?: string | null;
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
  if (!submitted) return { submitted: false };
  const files = (sub.attachments ?? []).slice(0, 20).map((a) => ({
    name: String(a.display_name || a.filename || "파일").slice(0, 120),
    size: typeof a.size === "number" ? a.size : null,
  }));
  const submission: ApiItem["submission"] = { type: sub.submission_type ?? null, files };
  if (sub.submission_type === "online_url" && sub.url) submission.url = String(sub.url).slice(0, 300);
  return { submitted: true, submittedAt: sub.submitted_at!, submission };
}

export async function fetchCanvasApi(origin: string, token: string): Promise<ApiItem[]> {
  const base = origin.replace(/\/+$/, "");
  const courses = await getAll<Course>(
    `${base}/api/v1/courses?enrollment_state=active&enrollment_type=student&per_page=100`, token, 5);

  const items = new Map<string, ApiItem>();
  for (const c of courses) {
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
  return [...items.values()];
}

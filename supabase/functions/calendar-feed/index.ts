// calendar-feed: 보드의 과제·시험을 iCalendar(.ics)로 내보낸다.
// 구글 캘린더 / 아이폰 캘린더에서 "URL로 구독"하면 주기적으로 다시 읽어 간다.
//
// GET /functions/v1/calendar-feed?k=<캘린더 열쇠>
//   - 열쇠는 보드 코드와 다른 읽기 전용 값 (설정에서 만들고, 다시 만들면 이전 주소는 막힘)

import { createClient } from "npm:@supabase/supabase-js@2";

type Task = {
  id: string; kind: string; title: string; subject: string; due: string; endAt: string | null;
  location: string; done: boolean; link: string | null; memo: string; missing?: boolean;
};

const APP_URL = "https://dday-board-pink.vercel.app/";

// RFC 5545: 쉼표 · 세미콜론 · 역슬래시 · 줄바꿈 이스케이프, 75바이트마다 줄 접기
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function fold(line: string) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ""; }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function toIcs(tasks: Task[], now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//dday-board//KO", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:S-DAY", "X-WR-TIMEZONE:Asia/Seoul", "REFRESH-INTERVAL;VALUE=DURATION:PT3H",
  ];
  for (const t of tasks) {
    const exam = t.kind === "exam";
    const start = new Date(t.due);
    // 과제는 마감 시각에 30분짜리, 시험은 시작~끝(없으면 1시간)
    const end = exam && t.endAt ? new Date(t.endAt) : new Date(start.getTime() + (exam ? 60 : 30) * 60000);
    const head = exam ? "[시험] " : t.done ? "[완료] " : t.missing ? "[미제출] " : "[마감] ";
    const desc = [t.subject, t.memo, t.link].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.id}@dday-board`,
      `DTSTAMP:${stamp(now.toISOString())}`,
      `DTSTART:${stamp(start.toISOString())}`,
      `DTEND:${stamp(end.toISOString())}`,
      fold(`SUMMARY:${esc(head + (t.subject ? `${t.subject} ` : "") + t.title)}`),
    );
    if (desc) lines.push(fold(`DESCRIPTION:${esc(desc)}`));
    if (exam && t.location) lines.push(fold(`LOCATION:${esc(t.location)}`));
    lines.push(`URL:${APP_URL}#task=${encodeURIComponent(t.id)}`);
    if (!t.done && !exam) {
      // 하루 전 알림
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", fold(`DESCRIPTION:${esc(t.title)}`), "TRIGGER:-P1D", "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const key = new URL(req.url).searchParams.get("k") ?? "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(key)) return new Response("not found", { status: 404 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await supa.rpc("dday_svc_calendar", { p_key: key });
  if (error) return new Response("error", { status: 500 });
  if (data == null) return new Response("not found", { status: 404 });

  return new Response(toIcs(data as Task[]), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="s-day.ics"',
      "Cache-Control": "public, max-age=900",
    },
  });
});

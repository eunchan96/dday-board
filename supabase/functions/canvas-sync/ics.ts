// Canvas 캘린더 피드(.ics)에서 과제만 뽑아 보드 형식으로 변환한다.
//
// 실제 피드 예시:
//   UID:event-assignment-743317
//   DTSTART;VALUE=DATE:20261015T000000        ← 날짜만 있음 (마감 시각 없음)
//   SUMMARY:HW2: SQL1 연습문제 [데이터베이스 (2150132402)]
//   URL:https://canvas.ssu.ac.kr/calendar?include_contexts=course_48406&...#assignment_743317

export type CanvasItem = {
  id: string;       // "canvas-743317"
  title: string;
  subject: string;
  due: string;      // ISO 8601
  link: string | null;
};

// 날짜만 있는 마감은 그날 23:59:59(한국 시간)으로 본다.
const DEFAULT_OFFSET = "+09:00";
const DATE_ONLY_TIME = "23:59:59";  // 스마트캠퍼스 과제 마감(due_at)과 같은 값

type Prop = { name: string; params: Record<string, string>; value: string };

function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function parseLine(line: string): Prop | null {
  // 이름;파라미터=값:내용  (파라미터 값 안의 ":"는 따옴표로 감싸져 있음)
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function toIso(prop: Prop): string | null {
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const dateOnly = prop.params["VALUE"] === "DATE" || hh === undefined;
  if (dateOnly) return `${y}-${mo}-${d}T${DATE_ONLY_TIME}${DEFAULT_OFFSET}`;
  // Z면 UTC, 아니면(TZID 지정 또는 floating) 한국 시간으로 간주
  return `${y}-${mo}-${d}T${hh}:${mi}:${ss}${z ? "Z" : DEFAULT_OFFSET}`;
}

function splitSummary(summary: string): { title: string; subject: string } {
  const s = summary.replace(/\s+/g, " ").trim();
  const m = s.match(/^(.*?)\s*\[([^\[\]]+)\]$/);
  if (!m) return { title: s, subject: "" };
  const subject = m[2].replace(/\s*\(\s*\d+\s*\)\s*$/, "").trim();
  return { title: m[1].trim() || s, subject };
}

function buildLink(feedOrigin: string | null, url: string | undefined, assignmentId: string): string | null {
  const course = url?.match(/course_(\d+)/)?.[1];
  if (feedOrigin && course) return `${feedOrigin}/courses/${course}/assignments/${assignmentId}`;
  return url ?? null;
}

export function parseCanvasFeed(text: string, feedUrl?: string): CanvasItem[] {
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("feed_invalid");
  let origin: string | null = null;
  try { origin = feedUrl ? new URL(feedUrl).origin : null; } catch { origin = null; }

  const items: CanvasItem[] = [];
  let cur: Record<string, Prop> | null = null;

  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur) {
        const uid = cur["UID"]?.value ?? "";
        const aid = uid.match(/^event-assignment-(\d+)$/)?.[1];  // 과제만
        const due = cur["DTSTART"] ? toIso(cur["DTSTART"]) : null;
        const summary = cur["SUMMARY"] ? unescapeText(cur["SUMMARY"].value) : "";
        if (aid && due && summary.trim()) {
          const { title, subject } = splitSummary(summary);
          items.push({
            id: `canvas-${aid}`,
            title: title.slice(0, 200),
            subject: subject.slice(0, 40),
            due,
            link: buildLink(origin, cur["URL"]?.value, aid),
          });
        }
      }
      cur = null;
      continue;
    }
    if (cur) {
      const p = parseLine(line);
      if (p && !(p.name in cur)) cur[p.name] = p;
    }
  }
  return items;
}

// push-notify: 마감이 다가온 과제·시험을 Web Push로 알린다.
//
// 호출 방법
//  - 예약 실행:   POST + 헤더 x-cron-secret      → 알림 시점이 지난 과제 + 쌓여 있는 한 번짜리 알림(토큰 만료, 새 공지) (10분마다)
//  - 테스트 알림: POST { code, endpoint }        → 그 기기로 테스트 알림 한 번
//
// 환경 변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (자동 제공)
//            VAPID 개인 키는 DB Vault(dday_vapid_private)에서 dday_svc_vapid로 읽는다

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const APP_URL = "https://dday-board-pink.vercel.app/";
// 공개 키 (앱의 assets/js/push.js와 같은 값)
const VAPID_PUBLIC = "BJtAnRQJ6vP-1pfTFyPeu15elS218tZA-FSGkUqV-sWIQOJXJ3gGeXieJPb6e-WdIVF5w4AS34e6VLsRMqgyUww";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Due = {
  subId: string; endpoint: string; p256dh: string; auth: string;
  taskId: string; title: string; subject: string; kind: string;
  location: string; due: string; lead: number;
};

const kst = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...opts }).format(d);

function remaining(ms: number) {
  // 10분마다 보내므로 몇 분 차이는 반올림해서 "3시간", "1일"처럼 보이게 한다
  const min = Math.max(1, Math.round(ms / 60000));
  if (min >= 1380) return `${Math.round(min / 1440)}일`;
  if (min >= 50) return `${Math.round(min / 60)}시간`;
  return `${min}분`;
}

export function message(t: Due, now = new Date()) {
  const due = new Date(t.due);
  const sameDay = kst(due, { dateStyle: "short" }) === kst(now, { dateStyle: "short" });
  const day = sameDay ? "오늘" : kst(due, { month: "numeric", day: "numeric", weekday: "short" });
  const time = kst(due, { hour: "numeric", minute: "2-digit" });
  const left = remaining(due.getTime() - now.getTime());
  const exam = t.kind === "exam";
  const head = exam ? `시험 ${left} 전` : `마감 ${left} 전`;
  const where = exam && t.location ? ` · ${t.location}` : "";
  // 시험은 "중간고사"만으로는 모르니 과목명을 앞에
  const name = exam && t.subject && !t.title.includes(t.subject) ? `${t.subject} ${t.title}` : t.title;
  return {
    title: `${head} · ${name}`,
    body: `${t.subject ? `${t.subject} · ` : ""}${day} ${time}${exam ? " 시작" : " 마감"}${where}`,
    tag: `task-${t.taskId}`,
    url: `${APP_URL}#task=${encodeURIComponent(t.taskId)}`,
  };
}

let vapidReady = false;
async function setupVapid(supa: ReturnType<typeof createClient>) {
  if (vapidReady) return;
  const { data: priv } = await supa.rpc("dday_svc_vapid");
  if (typeof priv !== "string" || !priv) throw new Error("vapid_missing");
  webpush.setVapidDetails(APP_URL, VAPID_PUBLIC, priv);
  vapidReady = true;
}

async function send(sub: { endpoint: string; p256dh: string; auth: string }, payload: unknown) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60, urgency: "high" },
    );
    return "ok" as const;
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return "gone" as const;   // 구독이 사라짐
    console.error("push failed", status, (e as Error).message);
    return "failed" as const;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  try { await setupVapid(supa); } catch { return json({ error: "vapid_missing" }, 500); }

  // 예약 실행
  const given = req.headers.get("x-cron-secret");
  if (given) {
    const { data: ok } = await supa.rpc("dday_svc_cron_ok", { p_secret: given });
    if (ok !== true) return json({ error: "unauthorized" }, 401);
    // 보낸 기록을 남길 수 없으면 같은 알림이 10분마다 반복되므로 보내지 않는다
    const check = await supa.rpc("dday_svc_push_done", { p_sent: [], p_gone: [], p_failed: [] });
    if (check.error) return json({ error: "record_unavailable" }, 500);
    const { data, error } = await supa.rpc("dday_svc_push_due");
    if (error) return json({ error: "lookup_failed" }, 500);

    const sent: { subId: string; taskId: string; due: string; lead: number }[] = [];
    const gone = new Set<string>(), failed = new Set<string>();
    for (const t of (data ?? []) as Due[]) {
      if (gone.has(t.subId)) continue;
      const r = await send(t, message(t));
      if (r === "ok") sent.push({ subId: t.subId, taskId: t.taskId, due: t.due, lead: t.lead });
      else if (r === "gone") gone.add(t.subId);
      else failed.add(t.subId);
    }
    // 한 번만 보내는 알림 (토큰 만료, 새 공지)
    let extra = 0;
    const { data: outbox } = await supa.rpc("dday_svc_outbox_take");
    type Out = { title: string; body: string; url: string | null; tag: string | null; subs: Due[] };
    for (const o of (outbox ?? []) as Out[]) {
      for (const s of o.subs ?? []) {
        if (gone.has(s.subId)) continue;
        const r = await send(s, { title: o.title, body: o.body, tag: o.tag ?? undefined, url: o.url ?? APP_URL });
        if (r === "ok") extra++;
        else if (r === "gone") gone.add(s.subId);
        else failed.add(s.subId);
      }
    }

    if (sent.length || gone.size || failed.size) {
      await supa.rpc("dday_svc_push_done", {
        p_sent: sent, p_gone: [...gone], p_failed: [...failed],
      });
    }
    return json({ due: (data ?? []).length, sent: sent.length, extra, gone: gone.size, failed: failed.size });
  }

  // 테스트 알림
  const body = await req.json().catch(() => ({}));
  const code = typeof body?.code === "string" ? body.code : "";
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!code || !endpoint) return json({ error: "missing_code" }, 400);

  const { data: sub, error } = await supa.rpc("dday_svc_push_one", { p_code: code, p_endpoint: endpoint });
  if (error) return json({ error: error.message.includes("invalid_code") ? "invalid_code" : "lookup_failed" }, 400);
  if (!sub) return json({ error: "not_subscribed" }, 404);

  const r = await send(sub, {
    title: "알림이 켜졌어요",
    body: "마감이 다가오면 이렇게 알려 드릴게요.",
    tag: "test",
    url: APP_URL,
  });
  if (r === "gone") {
    await supa.rpc("dday_svc_push_done", { p_sent: [], p_gone: [sub.subId], p_failed: [] });
    return json({ error: "subscription_gone" }, 410);
  }
  if (r === "failed") return json({ error: "push_failed" }, 502);
  return json({ ok: true });
});

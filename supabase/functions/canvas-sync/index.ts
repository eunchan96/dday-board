// canvas-sync: 스마트캠퍼스(Canvas) 캘린더 피드를 읽어 D-day 보드에 병합한다.
//
// 호출 방법
//  - 위젯 버튼:  POST { "code": "<보드 코드>" }          → 그 보드만 동기화
//  - 예약 실행:  POST + 헤더 x-cron-secret → 피드가 등록된 모든 보드 동기화
//                (비밀값은 DB Vault의 dday_cron_secret, pg_cron이 같은 값을 읽어 보냄)
//
// 환경 변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Supabase가 자동 제공)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { parseCanvasFeed } from "./ics.ts";

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

type Target = { board_id: string; feed_url: string | null };

async function syncOne(supa: SupabaseClient, t: Target) {
  let items;
  try {
    const res = await fetch(t.feed_url!, {
      headers: { "User-Agent": "dday-board-sync/1.0", "Accept": "text/calendar" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`feed_http_${res.status}`);
    items = parseCanvasFeed(await res.text(), t.feed_url!);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.startsWith("feed_") ? msg : "feed_fetch_failed";
    await supa.rpc("dday_svc_canvas_merge", { p_board: t.board_id, p_items: [], p_error: code });
    return { error: code };
  }

  const { data, error } = await supa.rpc("dday_svc_canvas_merge", {
    p_board: t.board_id,
    p_items: items,
  });
  if (error) return { error: "merge_failed" };
  return { ...data, total: items.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // 예약 실행: 피드가 등록된 모든 보드
  const given = req.headers.get("x-cron-secret");
  if (given) {
    const { data: ok } = await supa.rpc("dday_svc_cron_ok", { p_secret: given });
    if (ok !== true) return json({ error: "unauthorized" }, 401);
    const { data, error } = await supa.rpc("dday_svc_feeds");
    if (error) return json({ error: "lookup_failed" }, 500);
    const results = [];
    for (const t of (data ?? []) as Target[]) results.push(await syncOne(supa, t));
    return json({ boards: results.length, results });
  }

  // 위젯 버튼: 보드 코드로 한 보드만
  const body = await req.json().catch(() => ({}));
  const code = typeof body?.code === "string" ? body.code : "";
  if (!code) return json({ error: "missing_code" }, 400);

  const { data, error } = await supa.rpc("dday_svc_board_feed", { p_code: code });
  if (error) return json({ error: "lookup_failed" }, 500);
  const target = (data ?? [])[0] as Target | undefined;
  if (!target) return json({ error: "invalid_code" }, 404);
  if (!target.feed_url) return json({ error: "no_feed" }, 400);

  const result = await syncOne(supa, target);
  return json(result, "error" in result ? 502 : 200);
});

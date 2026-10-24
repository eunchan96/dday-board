// widget: 폰 홈 화면 위젯이 읽어 가는 JSON (다가오는 일정 · 오늘 공부 · 타이머)
//
// GET /functions/v1/widget?k=<위젯 열쇠>
//   - 열쇠는 보드 코드와 다른 읽기 전용 값 (설정 → 위젯에서 만들고, 다시 만들면 이전 열쇠는 막힘)
//   - 아이폰 Scriptable 스크립트와 안드로이드 위젯 앱이 같은 주소를 쓴다

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "GET" } });
  if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: CORS });
  const key = new URL(req.url).searchParams.get("k") ?? "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(key)) return json({ error: "not_found" }, 404);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await supa.rpc("dday_svc_widget", { p_key: key });
  if (error) return json({ error: "server" }, 500);
  if (data == null) return json({ error: "not_found" }, 404);
  return json(data, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

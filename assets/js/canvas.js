// 스마트캠퍼스(Canvas) 데이터를 보드 과제 형식으로 바꾸기
//
// 받는 형식 두 가지
//  1) 플래너 API 응답: /api/v1/planner/items 를 브라우저에서 열어 저장한 파일 (앞에 while(1); 이 붙어 있음)
//  2) 북마클릿이 보내는 묶음: { type: 'dday-canvas', origin, courses: [...], assignments: [...] }
//     assignments는 /api/v1/courses/:id/assignments?include[]=submission 결과에 course_id가 붙은 것
//
// 내보내는 과제: { id: 'canvas-<과제번호>', title, subject, due, link, submitted?, submittedAt?, submission? }
// 과제 번호는 캘린더 피드의 event-assignment-<번호>와 같아서 중복 없이 합쳐진다.

const DEFAULT_ORIGIN = 'https://canvas.ssu.ac.kr';

const courseName = s => String(s || '').replace(/\s*\(\s*\d+\s*\)\s*$/, '').trim();
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

function absolute(origin, path) {
  if (!path) return null;
  try { return new URL(path, origin).href; } catch { return null; }
}

function submissionInfo(sub) {
  if (!sub) return {};
  const submitted = !!sub.submitted_at && sub.workflow_state !== 'unsubmitted';
  const files = (sub.attachments || []).map(a => ({
    name: String(a.display_name || a.filename || '파일').slice(0, 120),
    size: typeof a.size === 'number' ? a.size : null,
  })).slice(0, 20);
  const out = { submitted };
  if (submitted) {
    out.submittedAt = sub.submitted_at;
    out.submission = { type: sub.submission_type || null, files };
    if (sub.submission_type === 'online_url' && sub.url) out.submission.url = String(sub.url).slice(0, 300);
  }
  return out;
}

function fromAssignments(payload) {
  const origin = payload.origin || DEFAULT_ORIGIN;
  const courses = new Map((payload.courses || []).map(c => [c.id, c]));
  const items = [];
  for (const a of payload.assignments || []) {
    if (!a || !a.id || !a.due_at || a.locked_for_user === true && !a.due_at) continue;
    const c = courses.get(a.course_id);
    items.push({
      id: `canvas-${a.id}`,
      title: clean(a.name).slice(0, 200),
      subject: courseName(c ? c.name : '').slice(0, 40),
      due: a.due_at,
      link: absolute(origin, `/courses/${a.course_id}/assignments/${a.id}`),
      ...submissionInfo(a.submission),
    });
  }
  return items;
}

function fromPlanner(list, origin = DEFAULT_ORIGIN) {
  const items = [];
  for (const p of list) {
    if (!p || !p.plannable) continue;
    let aid = null;
    if (p.plannable_type === 'assignment') aid = p.plannable_id;
    else if (p.plannable_type === 'quiz') aid = p.plannable.assignment_id || null;
    if (!aid) continue;
    const due = p.plannable.due_at || p.plannable_date;
    if (!due) continue;
    const it = {
      id: `canvas-${aid}`,
      title: clean(p.plannable.title).slice(0, 200),
      subject: courseName(p.context_name).slice(0, 40),
      due,
      link: absolute(origin, `/courses/${p.course_id}/assignments/${aid}`),
    };
    if (p.submissions && typeof p.submissions === 'object') it.submitted = !!p.submissions.submitted;
    items.push(it);
  }
  return items;
}

// 같은 과제가 여러 번 나오면 정보가 많은 쪽을 남긴다
function dedupe(items) {
  const score = it => (it.submission ? 2 : 0) + ('submitted' in it ? 1 : 0);
  const map = new Map();
  for (const it of items) {
    if (!it.title) continue;
    const prev = map.get(it.id);
    if (!prev || score(it) > score(prev)) map.set(it.id, it);
  }
  return [...map.values()].sort((a, b) => new Date(a.due) - new Date(b.due));
}

export function parseCanvasData(input) {
  let data = input;
  if (typeof input === 'string') {
    const text = input.trim().replace(/^while\(1\);/, '');
    data = JSON.parse(text);
  }
  if (Array.isArray(data)) return dedupe(fromPlanner(data));
  if (data && data.type === 'dday-canvas') return dedupe(fromAssignments(data));
  throw new Error('invalid_import');
}

export function summarize(items, existingIds) {
  const fresh = items.filter(i => !existingIds.has(i.id)).length;
  const submitted = items.filter(i => i.submitted).length;
  const files = items.reduce((n, i) => n + (i.submission?.files?.length || 0), 0);
  return { total: items.length, fresh, submitted, files };
}

// 스마트캠퍼스 페이지에서 실행되는 북마클릿
// - 로그인된 세션으로 수강 과목과 과제(제출 정보 포함)를 모은다
// - 앱 창을 먼저 열고(팝업 차단 방지), 다 모이면 postMessage로 넘긴다. 보드 코드는 담지 않는다.
export function bookmarkletSource(appUrl) {
  const app = new URL(appUrl);
  const target = `${app.origin}${app.pathname}#import`;
  const code = `(async()=>{
const A=${JSON.stringify(target)},O=${JSON.stringify(app.origin)};
if(!/canvas/.test(location.hostname)&&!document.querySelector('#application')){alert('스마트캠퍼스(Canvas) 페이지에서 눌러 주세요');return}
const w=window.open(A,'dday-import');if(!w){alert('팝업이 막혔어요. 이 사이트의 팝업을 허용해 주세요');return}
const get=async u=>{const r=await fetch(u,{credentials:'same-origin',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(r.status);const t=await r.text();const n=(r.headers.get('Link')||'').match(/<([^>]+)>;\\s*rel="next"/);return{d:JSON.parse(t.replace(/^while\\(1\\);/,'')),n:n&&n[1]}};
const all=async u=>{let o=[];while(u){const x=await get(u);o=o.concat(x.d);u=x.n}return o};
const tell=m=>{try{w.postMessage(m,O)}catch(e){}};
let data;
try{const courses=await all('/api/v1/courses?enrollment_state=active&enrollment_type=student&per_page=100');
let assignments=[],i=0;for(const c of courses){i++;tell({type:'dday-canvas-progress',text:'과목 '+courses.length+'개 중 '+i+'번째를 읽는 중이에요'});try{const a=await all('/api/v1/courses/'+c.id+'/assignments?include[]=submission&per_page=100');assignments=assignments.concat(a.map(x=>Object.assign(x,{course_id:c.id})))}catch(e){}}
data={type:'dday-canvas',origin:location.origin,courses:courses.map(c=>({id:c.id,name:c.name,course_code:c.course_code})),assignments}}
catch(e){tell({type:'dday-canvas-error',message:String(e.message||e)});alert('스마트캠퍼스에서 정보를 읽지 못했어요 ('+e.message+'). 로그인 상태를 확인해 주세요');return}
const send=()=>{try{w.postMessage(data,O)}catch(e){}};
window.addEventListener('message',e=>{if(e.origin===O&&e.data==='dday-ready')send()});
send();setTimeout(send,1500);
})()`;
  return 'javascript:' + encodeURIComponent(code.replace(/\n/g, ''));
}

// 앱 쪽: 북마클릿에서 오는 데이터 받기
export function listenForCanvasData(onData, onStatus = () => {}) {
  window.addEventListener('message', e => {
    let host = '';
    try { host = new URL(e.origin).hostname; } catch { return; }
    if (!/^canvas\.|\.ac\.kr$|instructure\.com$/.test(host)) return;   // Canvas로 보이는 곳에서만
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'dday-canvas') onData(e.data, e.origin);
    else if (e.data.type === 'dday-canvas-progress') onStatus({ kind: 'progress', text: String(e.data.text || '') });
    else if (e.data.type === 'dday-canvas-error') onStatus({ kind: 'error', text: String(e.data.message || '') });
  });
  // 북마클릿에 준비됐다고 알리기 (여러 번 보내도 북마클릿이 중복 처리하지 않도록 앱에서 한 번만 받음)
  if (window.opener) {
    const ping = () => { try { window.opener.postMessage('dday-ready', '*'); } catch { /* 닫힘 */ } };
    ping(); setTimeout(ping, 800); setTimeout(ping, 2500);
  }
}

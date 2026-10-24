// Supabase 호출. 키는 공개용 publishable key이고, 데이터 접근은 보드 코드로 검증된다.

const PROJECT = 'https://azwiggxcvmeppkfvdbln.supabase.co';
const API_KEY = 'sb_publishable_d5_83pjNlpVx5h0VWvF7Jg_5vresbV-';
const RPC_URL = `${PROJECT}/rest/v1/rpc/`;
const LMS_SYNC_URL = `${PROJECT}/functions/v1/canvas-sync`;
const PUSH_URL = `${PROJECT}/functions/v1/push-notify`;

async function post(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { apikey: API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch {
    throw new Error('network');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok || (data && data.error && (url === LMS_SYNC_URL || url === PUSH_URL))) {
    throw new Error((data && (data.message || data.error)) || `http_${res.status}`);
  }
  return data;
}

export const rpc = (name, body) => post(RPC_URL + name, body);
export const CALENDAR_FEED_URL = `${PROJECT}/functions/v1/calendar-feed`;
export const WIDGET_URL = `${PROJECT}/functions/v1/widget`;

export const api = {
  createBoard: () => rpc('dday_create_board'),
  list: code => rpc('dday_list', { p_code: code }),
  upsert: (code, task) => rpc('dday_upsert', { p_code: code, p_task: task }),
  remove: (code, id) => rpc('dday_delete', { p_code: code, p_id: id }),
  importTasks: (code, tasks) => rpc('dday_import', { p_code: code, p_tasks: tasks }),
  lmsStatus: code => rpc('dday_canvas_status', { p_code: code }),
  setFeed: (code, url) => rpc('dday_set_canvas_feed', { p_code: code, p_url: url }),
  setToken: (code, token) => rpc('dday_set_canvas_token', { p_code: code, p_token: token }),
  setOrigin: (code, origin) => rpc('dday_set_canvas_origin', { p_code: code, p_origin: origin }),
  lmsSync: code => post(LMS_SYNC_URL, { code }),
  canvasImport: (code, items) => rpc('dday_canvas_import', { p_code: code, p_items: items }),
  notices: code => rpc('dday_announcements', { p_code: code }),
  noticesRead: code => rpc('dday_announcements_read', { p_code: code }),
  calendarKey: code => rpc('dday_calendar_key', { p_code: code }),
  calendarStatus: code => rpc('dday_calendar_status', { p_code: code }),
  widgetKey: code => rpc('dday_widget_key', { p_code: code }),
  widgetStatus: code => rpc('dday_widget_status', { p_code: code }),
  pushSubscribe: (code, sub, leads) => rpc('dday_push_subscribe', { p_code: code, p_sub: sub, p_leads: leads }),
  pushUnsubscribe: (code, endpoint) => rpc('dday_push_unsubscribe', { p_code: code, p_endpoint: endpoint }),
  pushStatus: (code, endpoint) => rpc('dday_push_status', { p_code: code, p_endpoint: endpoint }),
  pushTest: (code, endpoint) => post(PUSH_URL, { code, endpoint }),
  subjectColors: code => rpc('dday_subject_colors', { p_code: code }),
  subjectPrefs: code => rpc('dday_subject_prefs', { p_code: code }),
  setSubjectOrder: (code, order) => rpc('dday_set_subject_order', { p_code: code, p_order: order }),
  setCustomSubjects: (code, list) => rpc('dday_set_custom_subjects', { p_code: code, p_list: list }),
  setGroups: (code, data) => rpc('dday_set_groups', { p_code: code, p_data: data }),
  renameSubject: (code, from, to) => rpc('dday_rename_subject', { p_code: code, p_from: from, p_to: to }),
  setSubjectColor: (code, subject, color) => rpc('dday_set_subject_color', { p_code: code, p_subject: subject, p_color: color }),
  // 공부 모드
  study: (code, from) => rpc('dday_study', { p_code: code, p_from: from }),
  studyAdd: (code, session) => rpc('dday_study_add', { p_code: code, p_session: session }),
  timer: code => rpc('dday_timer', { p_code: code }),
  timerSet: (code, st) => rpc('dday_timer_set', { p_code: code, p_state: st }),
  studyRange: (code, from, to) => rpc('dday_study_range', { p_code: code, p_from: from, p_to: to }),
  studyRemove: (code, id, removed = true) => rpc('dday_study_remove', { p_code: code, p_id: id, p_removed: removed }),
  studyGoal: (code, minutes) => rpc('dday_study_goal', { p_code: code, p_minutes: minutes }),
  studyPlan: (code, plan) => rpc('dday_study_plan', { p_code: code, p_plan: plan }),
  studyPlanRemove: (code, id, removed = true) => rpc('dday_study_plan_remove', { p_code: code, p_id: id, p_removed: removed }),
  studyLive: (code, on) => rpc('dday_study_live', { p_code: code, p_on: on }),
  studyProfile: (code, nickname) => rpc('dday_study_profile', { p_code: code, p_nickname: nickname }),
  studyProfileHide: code => rpc('dday_study_profile_hide', { p_code: code }),
  studyNewCode: code => rpc('dday_study_new_code', { p_code: code }),
  friends: code => rpc('dday_friends', { p_code: code }),
  friendAdd: (code, friendCode) => rpc('dday_friend_add', { p_code: code, p_friend_code: friendCode }),
  friendRemove: (code, friendCode) => rpc('dday_friend_remove', { p_code: code, p_friend_code: friendCode }),
  friendAccept: (code, friendCode) => rpc('dday_friend_accept', { p_code: code, p_friend_code: friendCode }),
  friendRequests: code => rpc('dday_friend_requests', { p_code: code }),
};

export function errText(e) {
  const m = e && e.message ? e.message : String(e);
  switch (m) {
    case 'network': return '서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요';
    case 'invalid_code': return '보드 코드가 맞지 않아요';
    case 'too_many_tasks': return '보드 하나에 과제는 500개까지 저장돼요';
    case 'invalid_import': return '가져올 수 있는 형식이 아니에요';
    case 'invalid_feed_url': return '캘린더 피드 주소가 아니에요. …/feeds/calendars/….ics 형태인지 확인해 주세요';
    case 'no_feed': return '스마트캠퍼스 피드가 등록되지 않았어요';
    case 'feed_invalid': return '피드 내용을 읽을 수 없어요. 주소를 다시 복사해 주세요';
    case 'feed_fetch_failed': return '스마트캠퍼스에 접속하지 못했어요. 잠시 후 다시 시도해 주세요';
    case 'invalid_origin': return '주소를 확인해 주세요 (예: canvas.학교.ac.kr)';
    case 'invalid_token': return '토큰을 읽지 못했어요. 스마트캠퍼스에 나온 토큰 전체를 다시 복사해 붙여 넣어 주세요';
    case 'token_invalid': return '토큰이 만료됐거나 지워졌어요. 스마트캠퍼스에서 새 토큰을 만들어 넣어 주세요';
    case 'api_fetch_failed': return '스마트캠퍼스에 접속하지 못했어요. 잠시 후 다시 시도해 주세요';
    case 'api_unexpected': return '스마트캠퍼스가 예상과 다른 응답을 보냈어요. 잠시 후 다시 시도해 주세요';
    case 'push_denied': return '알림이 차단돼 있어요. 브라우저 주소창의 사이트 설정에서 알림을 허용해 주세요';
    case 'push_dismissed': return '알림 권한 요청을 닫았어요. 다시 눌러 허용해 주세요';
    case 'not_subscribed': case 'subscription_gone': return '이 기기의 알림 연결이 끊겼어요. 알림을 다시 켜 주세요';
    case 'push_failed': return '알림 서버가 응답하지 않아요. 잠시 후 다시 시도해 주세요';
    case 'too_many_devices': return '보드 하나에 알림 기기는 20대까지 연결돼요';
    case 'invalid_subscription': return '이 브라우저의 알림 정보를 읽지 못했어요';
    case 'invalid_session': return '공부 기록 시간이 맞지 않아요';
    case 'too_many_sessions': return '공부 기록이 너무 많아요';
    case 'invalid_plan': return '계획 내용을 다시 확인해 주세요';
    case 'too_many_plans': return '공부 계획이 너무 많아요';
    case 'invalid_goal': return '목표는 10분에서 24시간 사이로 정해 주세요';
    case 'invalid_nickname': return '닉네임은 1~20자로 적어 주세요';
    case 'friend_not_found': return '그 친구 코드를 찾지 못했어요. 코드를 다시 확인해 주세요';
    case 'friend_self': return '내 친구 코드예요';
    case 'profile_required': return '먼저 닉네임을 정해 주세요';
    case 'too_many_friends': return '친구는 50명까지 추가할 수 있어요';
    case 'invalid_order': return '과목 순서를 저장하지 못했어요';
    case 'invalid_subjects': return '과목을 저장하지 못했어요';
    case 'invalid_groups': return '분류를 저장하지 못했어요';
    case 'invalid_subject': return '과목 이름은 1~40자로 적어 주세요';
    case 'invalid_color': return '고를 수 있는 색이 아니에요';
    case 'invalid_range': return '불러올 기간이 너무 길어요';
    case 'no_profile': return '먼저 닉네임을 정해 주세요';
  }
  if (/^feed_http_(401|403|404)$/.test(m)) return '피드 주소가 더 이상 유효하지 않아요. 스마트캠퍼스에서 새로 복사해 주세요';
  if (/^api_http_/.test(m)) return `스마트캠퍼스가 오류로 응답했어요 (${m.slice(9)})`;
  if (/^feed_http_/.test(m)) return `스마트캠퍼스가 오류로 응답했어요 (${m.slice(10)})`;
  return `문제가 생겼어요 (${m})`;
}

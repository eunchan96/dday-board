# 과제 D-day

스마트캠퍼스 과제, 직접 적은 과제, 시험 일정을 마감 순으로 모아 보는 학기 플래너입니다. 단독 웹으로도, 노션 페이지에 임베드해서도 씁니다. 같은 보드 코드를 입력한 기기끼리 과제가 동기화됩니다.

- 서비스: https://dday-board-pink.vercel.app
- 프론트엔드: HTML / CSS / Vanilla JS ES 모듈 (빌드 없음)
- 백엔드: Supabase (PostgreSQL, RPC 함수, Edge Function, pg_cron)
- 배포: Vercel (GitHub `main` push 시 자동 배포)

## 기능

**보기**
- 목록: 마감 지남 / 오늘 / 내일 / 이번 주 / 다음 주 / 그 이후 / 완료로 묶어서 표시
- 캘린더: 월 단위, 날짜를 누르면 그날 과제와 "이 날짜에 과제 추가"
- 과목: 왼쪽(좁은 화면은 위쪽 칩)에서 과목을 고르면 그 과목만 보기
- 상단에 "다음 마감은 ○○, 남은 시간" 한 줄, 일주일 안의 시험이 있으면 한 줄 더

**과제**
- 과제명, 과목, 마감 일시, 메모. 목록 왼쪽 별로 중요 표시
- 체크 상자 없음: 스마트캠퍼스 과제는 제출하면 저절로 완료, 직접 넣은 과제는 편집 화면의 "제출 완료" 버튼, 시험은 시간이 지나면 저절로 끝난 일정
- 날짜는 작은 달력, 시간은 시계 다이얼로 고르고, 자주 쓰는 날짜·시간은 한 번에 선택
- 삭제는 바로 되돌리기 가능
- 삭제 후 5초 동안 되돌리기
- D-day: 3일 이내는 노란 형광펜, 24시간 이내는 분홍 형광펜, 마감 지남은 빨간 글씨, 그 밖에는 흐린 글씨

**시험**
- 시험 템플릿(추가 → 시험): 시험 이름 빠른 선택(중간고사, 기말고사, 퀴즈, 실기시험), 시작·끝나는 시각, 장소, 시험 범위 메모
- 시작 시각을 고르면 끝나는 시각이 1시간 뒤로 자동으로 채워지고, 시험 시간(50분~2시간)도 버튼으로 고를 수 있어요
- 시작 시각 기준 D-day, 시험 중에는 "시험 중", 끝나면 자동으로 지난 일정으로 이동
- 목록과 캘린더에서 과제와 구분해 표시하고, "시험만" 보기 제공

**마감 알림**
- 설정 → 마감 알림에서 기기마다 켜요. 알림 시점은 1일 전 · 3시간 전 · 1시간 전 · 30분 전 중에서 골라요 (기본 1일 전, 3시간 전)
- 시험은 시작 시각 기준, 완료한 과제는 알리지 않아요. 마감을 바꾸면 바뀐 마감 기준으로 다시 알려요
- 알림을 누르면 그 과제가 열린 채로 앱이 떠요
- 노션 임베드 안에서는 권한을 받을 수 없어서 "새 창에서 열기"로 안내해요. 아이폰은 홈 화면에 추가한 앱에서만 켤 수 있어요(iOS 16.4 이상)

**학기**
- 마감일로 학기를 자동으로 나눕니다: 3월 2일~8월 31일은 1학기, 9월 1일~다음 해 3월 1일은 2학기
- 상단에서 학기를 고르면 모든 보기와 통계가 그 학기 기준으로 바뀝니다 (기본은 이번 학기)

**찾기**
- 과제명·과목·메모 검색, 과목 필터, 완료 숨기기, 중요한 과제만 보기

**그 밖에**
- 스마트캠퍼스(Canvas) 과제 자동 가져오기 (아래 참고)
- 밝게 / 어둡게 / 시스템 설정 테마
- 단축키: `N` 새 과제, `E` 새 시험, `/` 검색, `1` `2` 목록 · 캘린더, `Esc` 닫기
- 앱으로 설치(PWA): 홈 화면 · 작업 표시줄 아이콘, 오프라인에서도 마지막으로 불러온 과제 보기, 앱 아이콘 길게 눌러 새 과제 · 새 시험 · 캘린더 바로가기
- 노션 임베드 같은 좁은 화면에서는 필터가 가로 칩으로 바뀌는 반응형 레이아웃
- 백업 텍스트 복사와 가져오기

## 파일 구성

```
index.html              화면 뼈대 (연결 화면, 앱, 상세 패널, 설정)
assets/style.css        디자인 토큰과 스타일 (모눈종이 + 형광펜 콘셉트)
assets/js/app.js        시작, 화면 그리기, 이벤트, 단축키
assets/js/views.js      목록 / 캘린더 보기
assets/js/store.js      상태, 낙관적 업데이트, 동기화, 되돌리기 삭제
assets/js/api.js        Supabase RPC와 Edge Function 호출, 오류 문구
assets/js/util.js       날짜·학기 계산, 과목 색, DOM 헬퍼
assets/js/canvas.js     스마트캠퍼스 데이터 변환, 북마클릿
assets/js/picker.js     달력, 시계 다이얼
assets/js/push.js       마감 알림 켜기 / 끄기
sw.js, manifest.webmanifest   PWA (캐시, 알림 표시, 바로가기)
supabase/migrations/    DB 스키마와 함수
supabase/functions/canvas-sync/   스마트캠퍼스 피드 동기화
supabase/functions/push-notify/   마감 알림 발송 (10분마다)
```

## 구조

```
브라우저 (노션 임베드 / 모바일 브라우저)
   │  POST /rest/v1/rpc/dday_*       (publishable key + 보드 코드)
   │  POST /functions/v1/canvas-sync (보드 코드)
   ▼
Supabase
   ├─ public.dday_* 함수            ← 외부에서 호출 가능한 입구
   ├─ Edge Function canvas-sync     ← Canvas 피드를 읽어 병합
   ├─ pg_cron                       ← 하루 3번 canvas-sync 실행
   └─ app 스키마 (boards, tasks)    ← API 비노출, 직접 접근 차단
```

## 스마트캠퍼스(Canvas) 연동

보드마다 두 가지 중 하나로 자동 연동합니다. 둘 다 `canvas-sync` Edge Function이 하루 3번(07:03, 13:03, 21:03 KST), 그리고 상단 새로고침 버튼을 누르면 바로 실행합니다 (다른 기기 변경 사항도 함께 불러옴).

### 액세스 토큰 (추천)

스마트캠퍼스 **계정 → 설정 → 승인된 통합 → + 새 액세스 토큰**에서 만든 토큰을 설정에 붙여 넣으면, 서버가 Canvas REST API로 직접 읽습니다.

- `GET /api/v1/courses?enrollment_state=active&enrollment_type=student` → 과목별 `GET /api/v1/courses/:id/assignments?include[]=submission`
- 이번 학기 수강 과목의 과제 전체, 정확한 마감 시각, 제출 여부, 제출 시각, 제출한 파일 이름과 크기를 가져옵니다.
- 토큰은 계정 전체 권한이 있는 값이라 테이블에 두지 않고 **Supabase Vault에 암호화해서** 저장합니다. 보드에는 Vault 항목 id와 끝 4자리만 남고, 화면에는 끝 4자리만 돌려줍니다. 앱은 읽기 요청만 보냅니다.
- 토큰이 만료되거나 지워지면(401) `token_invalid`로 기록하고 화면에 새 토큰을 넣으라고 안내합니다.
- 토큰이 있으면 캘린더 피드는 쓰지 않습니다 (두 경로가 마감 시각을 번갈아 바꾸지 않게).
- 만들 때 만료일을 학기 말로 정해 두는 걸 권장합니다.

### 캘린더 피드

스마트캠퍼스 캘린더 화면의 "캘린더 피드" 주소(`…/feeds/calendars/user_….ics`)를 등록하면 피드를 읽어 과제를 넣습니다. 토큰을 쓰지 않을 때의 대안입니다.

- 피드에서 `UID:event-assignment-*`인 항목만 과제로 봅니다.
- `SUMMARY`의 `과제명 [과목명 (학수번호)]`를 과제명과 과목으로 나눕니다.
- 피드에는 마감 날짜만 있고 시각이 없어서, 날짜만 있으면 그날 23:59:59(KST)로 봅니다.
- 피드는 지난 30일 일정까지만 내보내고 제출 정보가 없습니다.

### 공통 병합 규칙

- 처음 가져올 때 이미 마감이 지난 과제는 완료 상태로 넣습니다. 제출한 과제는 완료로 바꾸고, 완료를 미완료로 되돌리지는 않습니다.
- 사용자가 고친 제목, 과목, 마감은 `*_custom` 플래그로 기억해 이후 동기화가 덮어쓰지 않습니다.
- 스마트캠퍼스 과제를 지우면 실제로 지우지 않고 숨겨서, 다음 동기화 때 다시 생기지 않게 합니다.
- 한 번 가져온 과제는 스마트캠퍼스에서 빠져도 보드에 남습니다.

### 토큰 없이 학기 전체 가져오기 (북마클릿)

토큰을 쓰지 않을 때 피드의 30일 제한과 제출 정보 부족을 보완하려고, 설정에 **"D-day로 가져오기" 북마클릿**을 둡니다. 토큰을 연결하면 이 항목은 숨깁니다.

1. 북마클릿을 북마크바에 끌어다 놓습니다.
2. 스마트캠퍼스에 로그인한 화면에서 누르면, 로그인된 세션으로 `/api/v1/courses`와 과목별 `/api/v1/courses/:id/assignments?include[]=submission`을 모읍니다. 토큰이 필요 없습니다.
3. 앱 창을 열어 `postMessage`로 데이터를 넘기고, 앱에서 미리 보기 후 `dday_canvas_import`로 병합합니다.

- 제출 여부, 제출 시각, 제출한 파일 이름과 크기를 저장합니다. 인증 정보가 담긴 파일 다운로드 주소는 저장하지 않습니다.
- 보드 코드는 북마클릿에 넣지 않습니다. 앱 창이 자기 브라우저에 저장된 코드로 가져옵니다.
- 북마크바를 쓸 수 없으면 플래너 API(`/api/v1/planner/items`)를 브라우저에서 열어 저장한 파일을 올려도 됩니다. 이 경우 파일 이름 없이 제출 여부까지만 가져옵니다.

피드 주소는 로그인 없이 일정을 볼 수 있는 개인 주소라서, DB의 잠긴 스키마에만 저장하고 API로 다시 읽어 갈 수 없게 했습니다. 예약 실행 인증값은 Supabase Vault에 둡니다.

### 왜 노션 HTML 블록이 아니라 외부 호스팅인가

처음에는 노션 HTML 블록에 파일을 직접 넣었지만, 블록이 샌드박스 iframe으로 렌더링되면서 두 가지가 막혔습니다.

1. `<form>` 제출이 동작하지 않음 → 폼 태그 대신 버튼 클릭 이벤트로 처리
2. 외부 서버로의 `fetch`가 차단됨 → 위젯을 Vercel에 올리고 노션에서는 URL 임베드로 표시

## 보안 모델

로그인 없이 쓰기 위해 **보드 코드가 곧 열쇠**인 구조입니다.

- 보드 코드는 서버에서 생성하는 20자 무작위 문자열입니다. 헷갈리는 0, O, 1, I를 뺀 32자 알파벳을 써서 약 100비트입니다.
- DB에는 코드 원문이 아니라 SHA-256 해시만 저장합니다.
- 테이블은 API에 노출되지 않는 `app` 스키마에 두고, `anon`/`authenticated` 역할의 접근 권한을 모두 회수했습니다. RLS도 켜 두고 정책은 두지 않았습니다.
- 외부에서는 `SECURITY DEFINER` 함수 5개만 실행할 수 있고, 각 함수는 보드 코드를 검증한 뒤 해당 보드의 데이터만 다룹니다.
- 프론트엔드에 들어 있는 키는 Supabase의 공개용 publishable key입니다. 키가 노출돼도 코드 없이는 어떤 데이터도 읽거나 쓸 수 없습니다.

Supabase 보안 어드바이저는 "로그인 없이 실행 가능한 SECURITY DEFINER 함수" 경고를 띄우는데, 위 구조상 의도된 것입니다.

## API

모든 함수는 `POST {SUPABASE_URL}/rest/v1/rpc/{함수명}`으로 호출하고, 헤더에 `apikey`를 넣습니다.

| 함수 | 인자 | 반환 | 설명 |
|---|---|---|---|
| `dday_create_board` | 없음 | `text` | 새 보드를 만들고 코드 반환 |
| `dday_list` | `p_code` | `jsonb` 배열 | 보드의 과제 목록 (마감 순) |
| `dday_upsert` | `p_code`, `p_task` | `jsonb` | 과제 추가 또는 수정 |
| `dday_delete` | `p_code`, `p_id` | 없음 | 과제 삭제 (스마트캠퍼스 과제는 숨김) |
| `dday_import` | `p_code`, `p_tasks` | `int` | 여러 과제 일괄 추가 (이미 있는 id는 건너뜀) |
| `dday_set_canvas_feed` | `p_code`, `p_url` | `jsonb` | 피드 주소 등록, 빈 값이면 해제 |
| `dday_set_canvas_token` | `p_code`, `p_token` | `jsonb` | 액세스 토큰 등록 (Vault에 저장), 빈 값이면 해제 |
| `dday_canvas_status` | `p_code` | `jsonb` | 연동 여부(`feed`, `token`, `tokenHint`), 마지막 동기화 시각, 오류 |
| `dday_push_subscribe` | `p_code`, `p_sub`, `p_leads` | `jsonb` | 이 기기 알림 켜기 또는 알림 시점 변경 (`p_sub`은 `PushSubscription.toJSON()`, `p_leads`는 분 단위) |
| `dday_push_unsubscribe` | `p_code`, `p_endpoint` | 없음 | 이 기기 알림 끄기 |
| `dday_push_status` | `p_code`, `p_endpoint` | `jsonb` | 이 기기 알림 상태와 알림 시점 |

`dday_svc_*` 함수는 Edge Function(service_role) 전용이라 외부에서 호출할 수 없습니다.

`dday_upsert`의 `memo`, `starred`는 보내지 않으면 기존 값을 유지합니다.

Edge Function `POST {SUPABASE_URL}/functions/v1/canvas-sync`에 `{ "code": "<보드 코드>" }`를 보내면 그 보드를 바로 동기화하고 `{ added, updated, total }`을 돌려줍니다.

과제 형식:

```json
{ "id": "lzx1a2b3", "subject": "데이터베이스", "title": "ER 다이어그램", "due": "2026-10-20T14:59:00.000Z", "done": false,
  "memo": "", "starred": false, "source": "manual", "link": null, "doneAt": null, "createdAt": "…" }
```

Edge Function `push-notify`에 `{ "code", "endpoint" }`를 보내면 그 기기로 테스트 알림을 보냅니다. 예약 실행(10분마다)은 `x-cron-secret` 헤더로 인증하고, 알림 시점이 지난 과제마다 가장 가까운 시점 하나만 보낸 뒤 기록합니다. VAPID 개인 키는 Vault(`dday_vapid_private`)에만 있고, 공개 키는 `assets/js/push.js`와 함수에 들어 있습니다.

오류는 `invalid_code`, `too_many_tasks`(보드당 500개 제한), `invalid_import`, `invalid_feed_url`, `no_feed`, `feed_*` 메시지로 돌아옵니다.

## 직접 띄워 보기

1. Supabase 프로젝트를 만들고 `supabase/migrations/`의 SQL을 순서대로 실행합니다. `canvas_cron` 마이그레이션의 함수 URL은 자기 프로젝트 ref로 바꿉니다.
2. `supabase/functions/canvas-sync`와 `push-notify`를 Edge Function으로 배포합니다. 알림을 쓰려면 VAPID 키를 만들어(`npx web-push generate-vapid-keys`) 개인 키는 Vault에 `dday_vapid_private`로 넣고, 공개 키는 `assets/js/push.js`와 함수의 `VAPID_PUBLIC`에 넣습니다. 인증은 함수 안에서 보드 코드와 Vault 값으로 하므로 JWT 검증은 끕니다.
3. `assets/js/api.js` 상단의 `PROJECT`(Supabase 프로젝트 주소)와 `API_KEY`(publishable key)를 자기 프로젝트 값으로 바꿉니다.
4. 저장소 전체를 정적 호스팅(Vercel 등)에 올리고, 노션에서 `/embed`로 그 주소를 넣습니다.

빌드 과정은 없지만 ES 모듈을 쓰기 때문에 로컬에서는 `python3 -m http.server`처럼 간단한 서버로 열어야 합니다.

## 한계와 다음 단계

- 보드 코드를 잃어버리면 복구할 방법이 없습니다.
- 동기화는 주기적 조회 방식이라 다른 기기 변경이 최대 30초 늦게 보입니다.
- 같은 과제를 두 기기에서 동시에 수정하면 나중에 저장된 쪽이 남습니다.
- Supabase 무료 플랜은 오래 접속이 없으면 프로젝트가 일시정지될 수 있습니다.

생각 중인 것:

- `boards.owner_id`를 이용한 로그인 계정 연결

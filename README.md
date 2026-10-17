# 과제 D-day

스마트캠퍼스 과제와 직접 적은 과제를 마감 순으로 모아 보는 과제 플래너입니다. 단독 웹으로도, 노션 페이지에 임베드해서도 씁니다. 같은 보드 코드를 입력한 기기끼리 과제가 동기화됩니다.

- 서비스: https://dday-board-pink.vercel.app
- 프론트엔드: HTML / CSS / Vanilla JS ES 모듈 (빌드 없음)
- 백엔드: Supabase (PostgreSQL, RPC 함수, Edge Function, pg_cron)
- 배포: Vercel (GitHub `main` push 시 자동 배포)

## 기능

**보기**
- 목록: 마감 지남 / 오늘 / 내일 / 이번 주 / 다음 주 / 그 이후 / 완료로 묶어서 표시
- 캘린더: 월 단위, 날짜를 누르면 그날 과제와 "이 날짜에 과제 추가"
- 과목별: 과목마다 남은 과제, 가장 가까운 마감, 완료율
- 상단에 "다음 마감은 ○○, 남은 시간" 한 줄과 이번 주 마감·마감 지남·완료 수

**과제**
- 과제명, 과목, 마감 일시, 메모, 중요 표시, 제출 완료
- 빠른 날짜 선택(오늘, 내일, 금요일, 다음 주 월요일, 1주 뒤)
- 삭제 후 5초 동안 되돌리기
- D-day 배지: 3일 이내는 노란 형광펜, 24시간 이내는 분홍 형광펜, 마감 지남은 빨간 물결 밑줄

**찾기**
- 과제명·과목·메모 검색, 과목 필터, 완료 숨기기, 중요한 과제만 보기

**그 밖에**
- 스마트캠퍼스(Canvas) 과제 자동 가져오기 (아래 참고)
- 밝게 / 어둡게 / 시스템 설정 테마
- 단축키: `N` 새 과제, `/` 검색, `1` `2` `3` 보기 전환, `Esc` 닫기
- 홈 화면에 추가(PWA), 앱 화면 오프라인 캐시
- 노션 임베드 같은 좁은 화면에서는 필터가 가로 칩으로 바뀌는 반응형 레이아웃
- 백업 텍스트 복사와 가져오기

## 파일 구성

```
index.html              화면 뼈대 (연결 화면, 앱, 상세 패널, 설정)
assets/style.css        디자인 토큰과 스타일 (모눈종이 + 형광펜 콘셉트)
assets/js/app.js        시작, 화면 그리기, 이벤트, 단축키
assets/js/views.js      목록 / 캘린더 / 과목별 보기
assets/js/store.js      상태, 낙관적 업데이트, 동기화, 되돌리기 삭제
assets/js/api.js        Supabase RPC와 Edge Function 호출, 오류 문구
assets/js/util.js       날짜 계산, 과목 색, DOM 헬퍼
sw.js, manifest.webmanifest   PWA
supabase/migrations/    DB 스키마와 함수
supabase/functions/canvas-sync/   스마트캠퍼스 피드 동기화
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

스마트캠퍼스 캘린더 화면의 "캘린더 피드" 주소(`…/feeds/calendars/user_….ics`)를 위젯 설정에 등록하면, `canvas-sync` Edge Function이 피드를 읽어 과제를 보드에 넣습니다.

- 실행 시점: 하루 3번(07:03, 13:03, 21:03 KST) 자동, 위젯의 **LMS** 버튼으로 즉시
- 피드에서 `UID:event-assignment-*`인 항목만 과제로 봅니다.
- `SUMMARY`의 `과제명 [과목명 (학수번호)]`를 과제명과 과목으로 나눕니다.
- 피드에는 마감 날짜만 있고 시각이 없어서, 날짜만 있으면 그날 23:59(KST)로 봅니다.
- 처음 가져올 때 이미 마감이 지난 과제는 완료 상태로 넣습니다.
- 사용자가 고친 제목, 과목, 마감은 `*_custom` 플래그로 기억해 이후 동기화가 덮어쓰지 않습니다.
- 스마트캠퍼스 과제를 지우면 실제로 지우지 않고 숨겨서, 다음 동기화 때 다시 생기지 않게 합니다.
- 피드에 제출 여부는 없어서 완료 체크는 직접 해야 합니다.

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
| `dday_canvas_status` | `p_code` | `jsonb` | 연동 여부, 마지막 동기화 시각, 오류 |

`dday_svc_*` 함수는 Edge Function(service_role) 전용이라 외부에서 호출할 수 없습니다.

`dday_upsert`의 `memo`, `starred`는 보내지 않으면 기존 값을 유지합니다.

Edge Function `POST {SUPABASE_URL}/functions/v1/canvas-sync`에 `{ "code": "<보드 코드>" }`를 보내면 그 보드를 바로 동기화하고 `{ added, updated, total }`을 돌려줍니다.

과제 형식:

```json
{ "id": "lzx1a2b3", "subject": "데이터베이스", "title": "ER 다이어그램", "due": "2026-10-20T14:59:00.000Z", "done": false,
  "memo": "", "starred": false, "source": "manual", "link": null, "doneAt": null, "createdAt": "…" }
```

오류는 `invalid_code`, `too_many_tasks`(보드당 500개 제한), `invalid_import`, `invalid_feed_url`, `no_feed`, `feed_*` 메시지로 돌아옵니다.

## 직접 띄워 보기

1. Supabase 프로젝트를 만들고 `supabase/migrations/`의 SQL을 순서대로 실행합니다. `canvas_cron` 마이그레이션의 함수 URL은 자기 프로젝트 ref로 바꿉니다.
2. `supabase/functions/canvas-sync`를 Edge Function으로 배포합니다. 인증은 함수 안에서 보드 코드와 Vault 값으로 하므로 JWT 검증은 끕니다.
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

# 과제 D-day 보드

노션 페이지에 임베드해서 쓰는 과제 마감 관리 위젯입니다. 마감 임박 순으로 정렬하고 D-day와 남은 시간을 보여 주며, 같은 보드 코드를 입력한 기기끼리 과제가 동기화됩니다.

- 위젯: https://dday-board-pink.vercel.app
- 프론트엔드: HTML / CSS / Vanilla JS (빌드 없음, 파일 하나)
- 백엔드: Supabase (PostgreSQL + RPC 함수)
- 배포: Vercel 정적 호스팅

## 기능

- 과목, 과제명, 마감 일시로 과제 등록 (기본 마감 시각 23:59)
- 마감 임박 순 정렬, D-day 배지
  - 24시간 이내 빨강, 3일 이내 주황, 마감 지남은 꽉 찬 빨강
- 과목별 고정 색 칩, 과목명 자동완성
- 완료 체크, 완료 숨기기, 두 번 눌러야 지워지는 삭제
- 보드 코드 기반 기기 간 동기화 (30초 주기, 화면 복귀 시, ↻ 버튼)
- 로컬 저장 버전 위젯에서 쓰던 데이터 가져오기

## 구조

```
브라우저 (노션 임베드 / 모바일 브라우저)
   │  POST /rest/v1/rpc/dday_*   (공개 publishable key + 보드 코드)
   ▼
Supabase
   ├─ public.dday_* 함수 5개      ← 외부에서 호출 가능한 유일한 입구
   └─ app 스키마 (boards, tasks)  ← API 비노출, 직접 접근 차단
```

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
| `dday_delete` | `p_code`, `p_id` | 없음 | 과제 삭제 |
| `dday_import` | `p_code`, `p_tasks` | `int` | 여러 과제 일괄 추가 (이미 있는 id는 건너뜀) |

과제 형식:

```json
{ "id": "lzx1a2b3", "subject": "데이터베이스", "title": "ER 다이어그램", "due": "2026-10-20T14:59:00.000Z", "done": false }
```

오류는 `invalid_code`, `too_many_tasks`(보드당 500개 제한), `invalid_import` 메시지로 돌아옵니다.

## 직접 띄워 보기

1. Supabase 프로젝트를 만들고 `supabase/migrations/`의 SQL을 실행합니다.
2. `index.html` 상단의 `API_URL`, `API_KEY`를 자기 프로젝트 값으로 바꿉니다.
   - `API_URL`: `https://<project-ref>.supabase.co/rest/v1/rpc/`
   - `API_KEY`: 프로젝트의 publishable key
3. 정적 호스팅(Vercel 등)에 `index.html`을 올리고, 노션에서 `/embed`로 그 주소를 넣습니다.

빌드 과정이 없어서 `index.html`을 브라우저로 바로 열어도 동작합니다.

## 한계와 다음 단계

- 보드 코드를 잃어버리면 복구할 방법이 없습니다.
- 동기화는 주기적 조회 방식이라 다른 기기 변경이 최대 30초 늦게 보입니다.
- 같은 과제를 두 기기에서 동시에 수정하면 나중에 저장된 쪽이 남습니다.
- Supabase 무료 플랜은 오래 접속이 없으면 프로젝트가 일시정지될 수 있습니다.

생각 중인 것:

- 스마트캠퍼스 캘린더(iCal) 구독 주소를 읽어 과제를 자동으로 등록
- `boards.owner_id`를 이용한 로그인 계정 연결

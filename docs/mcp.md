# S-DAY 읽기 전용 MCP

`list_events`는 **한 보드**에서 지정한 날짜의 일정만 읽습니다. `source`는 `manual`(직접 추가), `canvas`(스마트캠퍼스) 또는 `all`(기본)입니다. 날짜는 서울 기준, `from` 포함 및 `to` 제외이며 최대 31일입니다. 시험은 시작일, 과제는 마감일 기준으로 조회합니다. 종일 일정은 날짜만 반환합니다. 한 응답에는 최대 100개이며 `truncated`가 참이면 기간을 좁히면 됩니다.

```json
{ "from": "2026-11-25", "to": "2026-12-02", "source": "manual" }
```

반환값은 제목, 종류, 출처, 날짜, 시각, 종일 여부뿐입니다. 숨긴 항목, 메모, 링크, 장소, 공부 기록, 타인 보드는 반환하지 않습니다. 생성·수정·삭제 도구는 없습니다. 기존 보드 코드와 브라우저 저장소를 사용하지 않습니다.

## 로컬 검증

Node.js 24에서 `npm ci && npm test`를 실행합니다. 실제 PostgreSQL 엔진(PGlite)의 샘플 보드 두 개와 서명된 테스트 토큰으로 MCP HTTP 조회, 타 보드 격리, 직접 입력 필터, 날짜 경계, 민감 필드 제외, 잘못되거나 만료된 인증 및 권한 철회를 검사합니다. 운영 데이터 또는 실제 토큰은 사용하지 않습니다.

## 배포 전 준비: 샘플 환경부터

1. 테스트용 Supabase에서 기존 스키마와 새 마이그레이션을 적용하고, 운영 보드가 아닌 샘플 보드를 준비합니다. 이 마이그레이션은 기존 데이터나 RPC를 변경하지 않습니다.
2. 인증 제공자에 전용 API를 만들고 canonical HTTPS MCP 주소를 audience로 사용합니다. `sday:read` 권한만 등록하고 MCP 클라이언트의 OAuth authorization-code + PKCE 흐름, resource 파라미터, 클라이언트 등록 및 메타데이터가 지원되는지 확인합니다. JWT는 RS256, 정확한 발급자·audience, `sub`, `exp`, `scope`가 필요합니다. 계정 매핑은 MVP에서 한 명만 허용합니다. 공급자와 ChatGPT 연결은 따로 검증해야 합니다. [OpenAI 인증 요건](https://developers.openai.com/plugins/build/auth)
3. 32바이트 무작위 값을 로컬에서 생성해 소문자 64자리 hex로 보관합니다. 채팅, 소스, 로그, URL에 넣지 않습니다. 이 문자열 자체(바이트 디코딩 전)의 SHA-256 hex만 샘플 DB 관리자 환경에서 등록합니다. 예시의 해시는 실제 키가 아닙니다.
   ```sql
   insert into app.mcp_read_grants (key_hash, board_id, label)
   values (decode('<SHA-256 hex of the 64-character key>', 'hex'), '<sample board UUID>', 'dot sample');
   ```
4. Vercel의 서버 전용 변수를 **샘플 배포에만** 지정합니다. `main`으로 합치기 전에 OAuth 연결과 샘플 결과를 실제로 확인합니다.

| 변수 | 의미 |
| --- | --- |
| `SDAY_MCP_RESOURCE` | 공개 HTTPS 주소 + `/api/mcp`. OAuth audience와 일치 |
| `SDAY_MCP_ISSUER` | 발급자의 정확한 issuer 문자열 |
| `SDAY_MCP_JWKS_URL` | HTTPS 공개 서명 키 주소 |
| `SDAY_MCP_SUBJECT` | 이 보드에 연결할 OAuth 사용자 `sub` |
| `SDAY_MCP_DATABASE_KEY` | 3번에서 생성한 읽기 전용 값. 기존 보드 코드 아님 |
| `SDAY_SUPABASE_URL` | 샘플 Supabase 프로젝트 URL |
| `SDAY_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_` 공개 키. service-role/secret 키 사용 금지 |

MCP 엔드포인트와 보호 리소스 메타데이터는 설정이 없을 때 503을 반환합니다. MCP 도구 목록만 인증 없이 탐색할 수 있고, 일정 조회는 유효한 OAuth 권한과 샘플 보드용 서버 키가 모두 필요합니다. 조회 시 서버는 보드 코드나 Supabase 서비스 키를 전달하지 않습니다. HTTPS 헤더로 접속하는 표준 MCP 클라이언트를 대상으로 합니다.

### 연결 및 해제

ChatGPT 웹에서 [비공개 MCP 서버 추가 안내](https://developers.openai.com/api/docs/guides/custom-mcp-server)에 따라 배포 주소의 `/api/mcp`를 연결합니다. 해당 워크스페이스가 비공개 플러그인을 허용하는지, Dot 대화에 도구가 실제로 노출되는지 확인합니다. 실제 보드에는 별도 동의를 받은 뒤 테스트 환경에서 확인한 설정을 적용합니다.

즉시 읽기를 끊으려면 DB 관리자가 해당 읽기 권한 행을 `key_hash`로 지웁니다. 키 교체는 새 해시를 등록하고 서버 설정을 바꾼 뒤 이전 행을 제거합니다. 기존 보드 코드에 영향은 없습니다.

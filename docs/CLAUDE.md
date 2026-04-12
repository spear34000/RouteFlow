# RouteFlow — CLAUDE.md

Claude 기준 작업 문서는 [`AGENTS.md`](./AGENTS.md)와 동일한 기준을 따른다.

## 작업 원칙

- RouteFlow의 핵심 메시지인 `REST처럼 사용하지만 DB 변경 시 자동 푸시`를 흐리지 않는다.
- 구현보다 문서가 앞서 나가지 않게 한다.
- 공식 지원 DB와 실험적 DB를 항상 구분한다.
- 예제는 패키지보다 코드 디렉토리 형태를 우선한다.

## 우선순위

1. `@Reactive` live 경험이 실제로 보이는가
2. 어댑터 교체가 API 코드 변경 없이 가능한가
3. WebSocket/SSE 내부 구현이 사용자 API 밖으로 새지 않는가

## 참고

상세 프로젝트 구조, 구현 현황, 코딩 규칙은 [`docs/AGENTS.md`](./AGENTS.md)를 기준으로 본다.

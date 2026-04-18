# RouteFlow Docs

RouteFlow를 실제로 쓰는 순서대로 문서를 정리합니다.

## 시작 순서

1. [`getting-started.md`](./getting-started.md) - 가장 짧은 서버/클라이언트 예제로 바로 시작
2. [`why-routeflow.md`](./why-routeflow.md) - 왜 이 프로젝트가 필요한지, 어떤 문제를 쉽게 푸는지
3. [`examples.md`](./examples.md) - Todo와 Differentiation 예제로 기능 감 잡기
4. [`usage-guide.md`](./usage-guide.md) - 운영에서 덜 고생하는 설계 패턴
5. [`server.md`](./server.md) - `createApp`, `@Route`, `@Reactive` 사용법
6. [`client.md`](./client.md) - `createClient`, `subscribe()` 사용법
7. [`adapters.md`](./adapters.md) - `MemoryAdapter`, `PostgresAdapter`, `PollingAdapter` 연결 방식

## 참고 문서

- [`releases/v1.0.22.md`](./releases/v1.0.22.md) - 구독 라우팅 최적화, SQLite statement cache, graceful shutdown, `/_health`, `X-Request-ID`
- [`releases/v1.0.0.md`](./releases/v1.0.0.md) - 첫 정식 릴리스 노트

## 문서 원칙

- 루트 [`README.md`](../README.md)는 저장소 소개와 데모 진입점만 다룬다.
- `docs/`는 RouteFlow 사용법과 릴리스 노트를 다룬다.
- 사용자는 `getting-started.md`부터 읽고, `why-routeflow.md`로 문제 정의를 확인한 뒤 세부 문서로 내려간다.

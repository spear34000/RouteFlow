# RouteFlow Docs

RouteFlow를 실제로 쓰는 순서대로 문서를 정리합니다.

## 시작 순서

1. [`getting-started.md`](./getting-started.md) - 가장 짧은 서버/클라이언트 예제로 바로 시작
2. [`server.md`](./server.md) - `createApp`, `@Route`, `@Reactive` 사용법
3. [`client.md`](./client.md) - `createClient`, `subscribe()` 사용법
4. [`adapters.md`](./adapters.md) - `MemoryAdapter`, `PostgresAdapter`, `PollingAdapter` 연결 방식

## 참고 문서

- [`releases/v0.1.1.md`](./releases/v0.1.1.md) - npm 공개 패키지 릴리스 노트
- [`releases/v0.1.0.md`](./releases/v0.1.0.md) - `v0.1.0` 릴리스 노트

## 문서 원칙

- 루트 [`README.md`](../README.md)는 저장소 소개와 데모 진입점만 다룬다.
- `docs/`는 RouteFlow 사용법과 릴리스 노트를 다룬다.
- 사용자는 `getting-started.md`부터 읽고, 필요할 때 세부 문서로 내려간다.

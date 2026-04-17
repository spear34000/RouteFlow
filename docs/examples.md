# Examples

RouteFlow를 가장 빠르게 이해하는 방법은 작은 예제를 직접 띄워 보는 것입니다.

## 추천 순서

1. `Todo` 예제 — 가장 짧고 실제 CRUD + live 흐름이 명확함
2. `Memory/SQLite` 데모 — 브라우저 UI로 REST와 live 동작을 함께 확인
3. `Chat` 예제 — `push: 'delta'` 패턴 확인
4. `Board` 예제 — 여러 리소스를 동시에 `flow()`로 노출하는 패턴 확인

## Todo 예제

가장 먼저 실행할 예제입니다.

```bash
pnpm install
pnpm run example:todos
```

서버가 뜨면:

- `GET http://localhost:3020/todos`
- `GET http://localhost:3020/todos/live`
- `GET http://localhost:3020/_docs`

새 todo 생성:

```bash
curl -X POST http://localhost:3020/todos \
  -H "Content-Type: application/json" \
  -d '{"title":"Ship RouteFlow docs","done":0,"createdAt":"2026-04-17T00:00:00.000Z"}'
```

Smoke test:

```bash
pnpm run example:todos:smoke
```

이 스크립트는 실제 예제 서버를 띄운 뒤 다음을 검증합니다.

- `GET /_health` 응답
- `GET /todos` 스냅샷 조회
- `POST /todos` 생성
- `/todos/live` 구독 push 수신

## 브라우저 데모

SQLite 데모:

```bash
pnpm run example:memory
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 을 열면 됩니다.

SSE 데모:

```bash
pnpm run example:memory:sse
```

## Chat 예제

```bash
pnpm run example:chat
```

메시지 리소스는 `push: 'delta'` 모드라서 새 메시지가 들어와도 전체 목록을 다시 조회하지 않고 변경 row만 push합니다.

## Board 예제

```bash
pnpm run example:board
```

여러 리소스를 `flow()`로 동시에 노출하는 구성을 볼 수 있습니다.

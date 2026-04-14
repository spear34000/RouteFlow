---
name: router-folw-skills
description: RouteFlow가 할 수 있는 것과 할 수 없는 것을 정리합니다.
---

# RouteFlow — Skills

## 핵심 기능

### REST → Live 전환

일반 REST 핸들러에 `@Reactive`를 붙이면 live 엔드포인트가 됩니다. DB 변경 이벤트가 들어오면 핸들러를 다시 실행하고 최신 결과를 구독 중인 클라이언트에 자동 푸시합니다.

```ts
@Reactive({ watch: 'orders' })
@Route('GET', '/orders/live')
async getLiveOrders(_ctx: Context) {
  return db.query('SELECT * FROM orders')
}
```

### 경로 기반 구독

클라이언트는 WebSocket 채널이나 이벤트 타입을 직접 다루지 않습니다. HTTP 경로로만 구독합니다.

```ts
client.subscribe('/orders/live', (orders) => render(orders))
```

### 어댑터 교체 — 컨트롤러 코드 불변

저장소와 어댑터가 바뀌어도 라우트 핸들러 코드는 그대로 유지됩니다.

```ts
// 로컬: MemoryAdapter
createApp({ adapter: new MemoryAdapter(), port: 3000 })

// 운영: PostgresAdapter (컨트롤러 동일)
createApp({ adapter: new PostgresAdapter({ connectionString: '...' }), port: 3000 })
```

### 전송 방식 선택

WebSocket과 SSE 중 선택할 수 있습니다. 핸들러와 클라이언트 구독 API는 동일합니다.

```ts
createApp({ adapter, transport: 'websocket', port: 3000 })
createApp({ adapter, transport: 'sse',       port: 3000 })
```

### 구독 필터링

같은 테이블을 보더라도 구독자마다 다른 결과를 받을 수 있습니다. 사용자별 데이터 분리나 권한 범위 좁히기에 사용합니다.

```ts
@Reactive({
  watch: 'orders',
  filter: (event, ctx) => {
    const row = event.newRow as { user_id: string } | null
    return row?.user_id === ctx.params.userId
  },
})
@Route('GET', '/orders/:userId/live')
async getLiveOrders(ctx: Context) { ... }
```

### 디바운스

짧은 시간에 이벤트가 몰릴 때 재계산 횟수를 줄입니다.

```ts
@Reactive({ watch: 'logs', debounce: 300 })
```

### 파일 기반 영구 저장 (SQLite)

Node 22.5+ 내장 `node:sqlite`를 사용해 서버 재시작 후에도 데이터를 유지합니다. 경로는 코드에서 직접 지정합니다.

```ts
const store = new SQLiteItemStore('./data/app.db')
const store = new SQLiteItemStore(process.env.DB_PATH ?? './data/app.db')
```

### `.routeflow` 자동 생성

`app.listen()` 시 프로젝트 루트에 `.routeflow/info.json`이 생성됩니다. 현재 실행 중인 서버의 포트, 어댑터, 등록된 라우트 목록, 시작 시각을 담습니다.

### 자동 재연결

클라이언트는 연결이 끊겨도 자동으로 재연결하고 구독을 복원합니다. 지수 백오프를 기본 지원합니다.

---

## 지원 DB

### 네이티브 공식 어댑터 (8종)

| DB | 변경 감지 방식 |
|---|---|
| PostgreSQL | LISTEN/NOTIFY + 트리거 |
| MySQL | binlog |
| MongoDB | Change Streams |
| Redis | Pub/Sub |
| DynamoDB | Streams |
| Elasticsearch | 외부 변경 소스 |
| OpenSearch | 외부 변경 소스 |
| Snowflake | stream/task |

### `PollingAdapter` (비공식 DB)

공식 어댑터가 없는 DB도 폴링 방식으로 연결할 수 있습니다. `readChanges` 콜백만 구현하면 됩니다.

```ts
new PollingAdapter<string>({
  intervalMs: 1000,
  async readChanges({ table, cursor }) {
    // DB에서 cursor 이후 변경 rows를 조회해서 반환
  },
})
```

---

## 할 수 없는 것 (현재 버전)

| 항목 | 설명 |
|---|---|
| 멀티 인스턴스 구독 동기화 | 구독 상태가 프로세스 메모리에 있으므로 인스턴스 간 동기화 없음 |
| 복잡한 조인 변경 추적 | 여러 테이블에 걸친 변경이 어떤 구독자에게 영향 주는지 자동 판별 불가 |
| 스키마 마이그레이션 | DB 스키마 변경은 직접 관리 |
| 브라우저에서 직접 DB 연결 | 서버를 통한 구독만 지원 |

---

## 패키지 구조

```
routeflow-api               ← 코어 + 모든 공식 어댑터 + PollingAdapter
routeflow-api/client        ← 브라우저/Node 클라이언트 SDK
routeflow-api/adapters/*    ← 개별 어댑터 (필요한 것만 import)
```

```bash
npm install routeflow-api        # 코어만
npm install routeflow-api pg     # PostgreSQL 포함
npm install routeflow-api mongodb # MongoDB 포함
```

---

## tsconfig 요구사항

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

> `reflect-metadata`는 `routeflow-api` 안에 번들되어 있어 별도 설치 불필요.  
> TC39 새 데코레이터 스펙(esbuild/tsx 기본값)도 지원합니다.


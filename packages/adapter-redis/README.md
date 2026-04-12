# @spear340000/adapter-redis

RouteFlow 공식 지원 Redis 어댑터.

Redis pub/sub 채널에 발행된 변경 메시지를 RouteFlow live 엔드포인트 갱신 신호로 연결합니다.

## 설치

```bash
pnpm add @spear340000/adapter-redis redis
```

## 사용법

```typescript
import { createClient } from 'redis'
import { createApp } from '@spear340000/core'
import { RedisAdapter } from '@spear340000/adapter-redis'

const subscriber = createClient({ url: process.env.REDIS_URL })
await subscriber.connect()

const app = createApp({
  adapter: new RedisAdapter({ subscriber }),
  port: 3000,
})
```

이 어댑터는 `flux:{table}` 채널의 메시지를 `ChangeEvent`로 바꿔 `@Reactive` 엔드포인트 재계산을 유도합니다.

채널 포맷 기본값은 `flux:{table}`이고, 메시지 payload는 아래 형태여야 합니다.

```json
{
  "table": "orders",
  "operation": "UPDATE",
  "newRow": { "id": 1, "total": 20 },
  "oldRow": { "id": 1, "total": 10 }
}
```

## 포지션

- 상태: `official`
- 권장 대상: Redis pub/sub 기반 변경 브리지
- 연결 방식: pub/sub

# @spear340000/adapter-snowflake

RouteFlow 공식 지원 Snowflake 어댑터.

Snowflake Stream/Task 파이프라인이나 외부 poller가 발행하는 변경 이벤트를 받아, live 엔드포인트 재계산 신호로 사용합니다.

## 설치

```bash
pnpm add @spear340000/adapter-snowflake
```

## 사용법

```typescript
import { createApp } from '@spear340000/core'
import { SnowflakeAdapter } from '@spear340000/adapter-snowflake'

const app = createApp({
  adapter: new SnowflakeAdapter({
    source: snowflakeChangeSource,
  }),
  port: 3000,
})
```

## 포지션

- 상태: `official`
- 권장 대상: Snowflake 기반 DW 파이프라인
- 연결 방식: stream/task source 또는 external poller

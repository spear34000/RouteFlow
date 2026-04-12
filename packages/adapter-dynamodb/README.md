# @spear340000/adapter-dynamodb

RouteFlow 공식 지원 DynamoDB 어댑터.

DynamoDB Streams 스타일 레코드를 RouteFlow `ChangeEvent`로 바꿔, 기존 REST 스타일 live 엔드포인트가 자동 갱신되도록 연결합니다.

## 설치

```bash
pnpm add @spear340000/adapter-dynamodb
```

## 사용법

```typescript
import { createApp } from '@spear340000/core'
import { DynamoDbAdapter } from '@spear340000/adapter-dynamodb'

const app = createApp({
  adapter: new DynamoDbAdapter({
    source: dynamoDbStreamSource,
  }),
  port: 3000,
})
```

기본 unmarshall은 `S`, `N`, `BOOL`, `NULL`, `M`, `L`, `SS`, `NS`를 처리합니다. AWS SDK의 `unmarshall`을 쓰고 싶으면 `unmarshall` 옵션으로 교체하면 됩니다.

## 포지션

- 상태: `official`
- 권장 대상: DynamoDB Streams 기반 서비스
- 연결 방식: Streams source

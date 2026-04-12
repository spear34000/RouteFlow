# @routeflow/adapter-mongodb

RouteFlow 공식 지원 MongoDB 어댑터.

기존 REST 엔드포인트는 유지한 채, MongoDB 컬렉션 변경이 생기면 live 엔드포인트 결과를 자동 갱신하는 흐름에 연결됩니다.

MongoDB Node 드라이버의 Change Streams를 사용합니다.

## 설치

```bash
pnpm add @routeflow/adapter-mongodb mongodb
```

## 사용법

```typescript
import { MongoClient } from 'mongodb'
import { createApp } from '@routeflow/core'
import { MongoDbAdapter } from '@routeflow/adapter-mongodb'

const client = new MongoClient(process.env.MONGODB_URL!)
await client.connect()

const app = createApp({
  adapter: new MongoDbAdapter({
    db: client.db('app'),
  }),
  port: 3000,
})
```

이 어댑터는 컬렉션 변경을 `ChangeEvent`로 변환해 `@Reactive` 엔드포인트 재계산 트리거로 사용합니다.

## 동작 원리

1. `onChange(collection)` 호출 시 해당 컬렉션용 Change Stream 준비
2. `connect()` 이후 컬렉션별 Change Stream 오픈
3. `insert/update/replace/delete` 이벤트를 RouteFlow `ChangeEvent`로 변환
4. `disconnect()` 시 열린 스트림 모두 종료

## 포지션

- 상태: `official`
- 권장 대상: MongoDB 기반 서비스
- 연결 방식: Change Streams

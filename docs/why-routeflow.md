# Why RouteFlow

RouteFlow는 "REST API는 그대로 두고, 실시간 동기화만 자연스럽게 붙이고 싶은 팀"을 위한 프로젝트입니다.

핵심 메시지는 이 한 줄입니다.

> REST처럼 쓰는데, DB 변경이 생기면 구독 중인 클라이언트에 자동으로 푸시된다.

## 어떤 문제를 풀려고 나왔나

많은 서비스가 처음에는 평범한 CRUD API로 시작합니다.

- `GET /rooms/:roomId/messages`
- `GET /projects/:projectId/tasks`
- `GET /feed?limit=20`
- `GET /posts?include=author`

문제는 "이 응답을 그대로 실시간으로 유지하고 싶다"는 순간부터 시작됩니다.

보통 여기서 해야 하는 일은 꽤 많습니다.

- WebSocket/SSE 채널 구조 설계
- query별 fan-out 그룹 분리
- room, team, project 같은 상위 자원별 스코프 분리
- relation 포함 응답의 재계산 시점 결정
- delta로 밀 수 있는지 snapshot으로 보내야 하는지 판단
- DB 변경 이벤트와 API 응답 shape 연결

즉, REST API 뒤에 별도의 실시간 시스템을 다시 한 번 만드는 셈입니다.

RouteFlow는 이 문제를 "route 결과" 중심으로 다시 정리합니다.

## RouteFlow의 접근

RouteFlow는 먼저 route를 만들고, 그 route를 live하게 만듭니다.

- 기존 REST endpoint를 그대로 유지한다
- 같은 자원에 `/live` endpoint를 붙인다
- DB 변경이 생기면 그 endpoint를 구독 중인 클라이언트에 최신 결과를 다시 보낸다

즉, "이벤트를 어떻게 설계할까?"보다 "이 API 결과를 어떻게 계속 최신으로 유지할까?"에 집중하게 해줍니다.

## 왜 더 쉬워지나

### 1. 문제 중심

RouteFlow가 줄여주는 가장 큰 복잡도는 이겁니다.

- 이벤트 브로커를 직접 설계하지 않아도 된다
- query/filter/include를 따로 해석하는 live 레이어를 다시 만들지 않아도 된다
- REST와 realtime이 서로 다른 모델로 흩어지지 않는다

### 2. 차별화 중심

RouteFlow는 특정 플랫폼의 row change stream을 그대로 노출하는 도구와 다릅니다.

- 응답은 DB row가 아니라 route 결과 기준이다
- adapter 패턴이라 특정 벤더에 묶이지 않는다
- SQLite, Postgres, MongoDB, Redis 등 여러 저장소 전략을 같은 앱 구조에서 다룰 수 있다

특히 다음 세 가지가 RouteFlow답습니다.

- Query-aware live
- Smart delta push
- Live include

### 3. 예제 중심

```ts
app.flow('/rooms/:roomId/messages', messages, {
  push: 'smart',
  queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
  query: 'auto',
  relations: {
    author: { store: users, foreignKey: 'authorId', watch: 'users' },
  },
  liveInclude: true,
})
```

이 한 블록으로 얻는 건 단순한 live endpoint 하나가 아닙니다.

- room-scoped 구독 분리
- query별 결과 fan-out
- 단순 feed에서는 delta push
- `?include=author` 응답의 relation 변경 재계산

## 언제 잘 맞나

- 기존 REST API를 버리지 않고 실시간 기능을 붙이고 싶을 때
- 채팅, 알림, activity feed처럼 live 목록 응답이 많을 때
- room/team/project 단위로 스코프가 자주 갈릴 때
- `?include=user` 같은 응답까지 실시간으로 유지해야 할 때
- 로컬/운영 저장소 전략이 다를 때

## 언제 덜 맞나

- 단순 row-level CDC stream만 있으면 충분한 경우
- 특정 BaaS 플랫폼에 깊게 묶여도 문제가 없는 경우
- route 결과보다 이벤트 로그 자체가 제품 중심인 경우

## 다음 읽을 문서

- 빠르게 써보려면 [`getting-started.md`](./getting-started.md)
- 어떤 식으로 설계하면 좋은지 보려면 [`usage-guide.md`](./usage-guide.md)
- 서버 API를 보려면 [`server.md`](./server.md)
- 예제를 먼저 보고 싶다면 [`examples.md`](./examples.md)

/**
 * Chat (메신저) 예제 — RouteFlow
 *
 * 실행:
 *   pnpm example:chat
 *
 * API:
 *   GET    /rooms                채팅방 목록 (실시간)
 *   POST   /rooms                채팅방 생성  { name }
 *   GET    /rooms/live           WS/SSE 구독
 *
 *   GET    /messages             전체 메시지 (최근 100개)
 *   POST   /messages             메시지 전송  { roomId, author, content }
 *   GET    /messages/live        WS/SSE 구독 → delta 모드: 새 메시지만 push
 *
 * delta 모드 페이로드 (messages/live):
 *   { operation: 'INSERT', row: { id, roomId, author, content, createdAt }, timestamp }
 *
 * 클라이언트 예시 (브라우저 콘솔):
 *   const ws = new WebSocket('ws://localhost:3011')
 *   ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', path: '/messages/live' }))
 *   ws.onmessage = e => {
 *     const { data: { operation, row } } = JSON.parse(e.data)
 *     if (operation === 'INSERT') console.log('새 메시지:', row.content)
 *   }
 */

import { createApp, rateLimit } from 'routeflow-api'
import { DBIStore } from 'routeflow-api/sqlite'

// ── DB 초기화 ─────────────────────────────────────────────────────────────────

const db = new DBIStore(process.env['DB_PATH'] ?? './data/chat.db')

const rooms = db.table('rooms', {
  name:      'text',
  createdAt: 'text',
})

const messages = db.table('messages', {
  roomId:    'integer',
  author:    'text',
  content:   'text',
  createdAt: 'text',
})

await rooms.seed([
  { name: '일반',   createdAt: new Date().toISOString() },
  { name: '기술토론', createdAt: new Date().toISOString() },
])

await messages.seed([
  { roomId: 1, author: 'system', content: '채팅방에 오신 것을 환영합니다!', createdAt: new Date().toISOString() },
])

// ── 앱 ───────────────────────────────────────────────────────────────────────

const transport = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'
const port      = Number(process.env['PORT'] ?? 3011)

const app = createApp({ adapter: db, transport, port })

// 전송 레이트 리미트: 분당 60메시지
app.use(rateLimit({ max: 60, windowMs: 60_000, message: '전송 한도를 초과했습니다 (60/min)' }))

app
  // 채팅방 목록 — snapshot 모드
  .flow('/rooms', rooms, { only: ['list', 'get', 'create', 'live'] })

  // 메시지 — delta 모드: 변경 시 DB 재조회 없이 변경된 row만 push
  // 초기 연결 시에는 snapshot(list) 로 전체 이력 제공
  .flow('/messages', messages, {
    only: ['list', 'create', 'live'],
    push: 'delta',   // ← 핵심: INSERT 발생 시 전체 목록 재조회 없이 새 메시지만 전송
  })

  .openapi({ title: '메신저 API' })
  .listen()

console.log(`[chat] Ready → http://localhost:${port}  (${transport})`)
console.log(`[chat] Docs  → http://localhost:${port}/_docs`)
console.log(`[chat] DB    → ${process.env['DB_PATH'] ?? './data/chat.db'}`)
console.log()
console.log('  새 메시지 전송 테스트:')
console.log(`  curl -X POST http://localhost:${port}/messages \\`)
console.log(`    -H "Content-Type: application/json" \\`)
console.log(`    -d '{"roomId":1,"author":"me","content":"안녕하세요!"}'`)

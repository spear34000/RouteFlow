/**
 * Board (게시판) 예제 — RouteFlow
 *
 * 실행:
 *   pnpm example:board
 *
 * API:
 *   GET    /posts              게시글 목록 (실시간)
 *   GET    /posts/:id          게시글 단건
 *   POST   /posts              게시글 작성   { title, content, author }
 *   PUT    /posts/:id          전체 수정
 *   PATCH  /posts/:id          부분 수정
 *   DELETE /posts/:id          삭제
 *   GET    /posts/live         WS/SSE 구독 → 게시글 변경 시 실시간 push
 *
 *   GET    /comments           댓글 목록
 *   POST   /comments           댓글 작성   { postId, author, content }
 *   GET    /comments/live      WS/SSE 구독 → 댓글 변경 시 실시간 push
 *
 *   GET    /openapi.json       OpenAPI 스펙
 *   GET    /_docs              Swagger UI
 */

import { createApp } from 'routeflow-api'
import { DBIStore } from 'routeflow-api/sqlite'

// ── DB 초기화 ─────────────────────────────────────────────────────────────────

const db = new DBIStore(process.env['DB_PATH'] ?? './data/board.db')

const posts = db.table('posts', {
  title:     'text',
  content:   'text',
  author:    'text',
  createdAt: 'text',
})

const comments = db.table('comments', {
  postId:    'integer',
  author:    'text',
  content:   'text',
  createdAt: 'text',
})

// 초기 데이터 (DB 가 비어 있을 때만 삽입)
await posts.seed([
  { title: '첫 번째 게시글', content: 'RouteFlow로 만든 게시판입니다.', author: 'admin', createdAt: new Date().toISOString() },
  { title: '실시간 게시판', content: '글을 작성하면 모든 탭에 즉시 반영됩니다.', author: 'admin', createdAt: new Date().toISOString() },
])

await comments.seed([
  { postId: 1, author: 'user1', content: '좋은 글 감사합니다!', createdAt: new Date().toISOString() },
])

// ── 앱 ───────────────────────────────────────────────────────────────────────

const transport = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'
const port      = Number(process.env['PORT'] ?? 3010)

const app = createApp({ adapter: db, transport, port })

app
  // 게시글 — snapshot 모드: 변경 시 전체 목록 재조회
  .flow('/posts', posts)
  // 댓글 — snapshot 모드
  .flow('/comments', comments)
  // OpenAPI + Swagger UI
  .openapi({ title: '게시판 API' })
  .listen()

console.log(`[board] Ready → http://localhost:${port}  (${transport})`)
console.log(`[board] Docs  → http://localhost:${port}/_docs`)
console.log(`[board] DB    → ${process.env['DB_PATH'] ?? './data/board.db'}`)

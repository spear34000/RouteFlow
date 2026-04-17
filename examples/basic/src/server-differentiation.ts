/**
 * RouteFlow differentiation example.
 *
 * Shows:
 * - Query-aware live subscriptions for room-scoped messages
 * - Smart delta push for room activity feed
 * - Live include recompute when related users change
 */

import { createApp } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'

const dbPath = process.env['DB_PATH'] ?? './data/differentiation.db'
const port = Number(process.env['PORT'] ?? 3030)
const transport = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'

const db = new RouteStore(dbPath)

const users = db.table('users', {
  username: 'text',
})

const rooms = db.table('rooms', {
  name: 'text',
})

const messages = db.table('messages', {
  roomId: 'integer',
  authorId: 'integer',
  content: 'text',
  createdAt: 'text',
})

const activity = db.table('activity', {
  roomId: 'integer',
  kind: 'text',
  body: 'text',
  createdAt: 'text',
})

await users.seed([
  { username: 'alice' },
  { username: 'bob' },
])

await rooms.seed([
  { name: 'general' },
  { name: 'support' },
])

await messages.seed([
  { roomId: 1, authorId: 1, content: 'Welcome to general', createdAt: '2026-04-17T00:00:00.000Z' },
  { roomId: 2, authorId: 2, content: 'Support room is live', createdAt: '2026-04-17T00:00:01.000Z' },
])

await activity.seed([
  { roomId: 1, kind: 'system', body: 'Room created', createdAt: '2026-04-17T00:00:00.000Z' },
])

const app = createApp({ adapter: db, port, transport })

app
  .flow('/users', users, {
    only: ['list', 'get', 'create', 'update'],
  })
  .flow('/rooms', rooms, {
    only: ['list', 'get', 'create'],
  })
  .flow('/rooms/:roomId/messages', messages, {
    only: ['list', 'create', 'live'],
    push: 'smart',
    queryFilter: (ctx) => ({ roomId: Number(ctx.params['roomId']) }),
    query: 'auto',
    relations: {
      author: { store: users, foreignKey: 'authorId' },
    },
    liveInclude: true,
    initialLimit: 20,
  })
  .flow('/activity', activity, {
    only: ['list', 'create', 'live'],
    push: 'smart',
    initialLimit: 20,
  })
  .openapi({ title: 'RouteFlow Differentiation Example', version: '1.0.0' })
  .listen()

console.log(`[differentiation] Ready → http://localhost:${port} (${transport})`)
console.log(`[differentiation] DB    → ${dbPath}`)
console.log(`[differentiation] Docs  → http://localhost:${port}/_docs`)
console.log('[differentiation] Try   → /rooms/1/messages?include=author&limit=10')
console.log('[differentiation] Live  → /rooms/1/messages/live?include=author&limit=10')
console.log('[differentiation] Live  → /activity/live')

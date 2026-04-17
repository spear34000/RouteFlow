import { createApp } from 'routeflow-api'
import { RouteStore } from 'routeflow-api/sqlite'

const dbPath = process.env['DB_PATH'] ?? './data/full-e2e.db'
const port = Number(process.env['PORT'] ?? 3040)
const transport = process.env['ROUTEFLOW_TRANSPORT'] === 'sse' ? 'sse' : 'websocket'

const db = new RouteStore(dbPath)

const todos = db.table('todos', {
  title: 'text',
  done: 'integer',
  createdAt: 'text',
})

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

await todos.seed([
  { title: 'first todo', done: 0, createdAt: '2026-04-17T00:00:00.000Z' },
])

await users.seed([
  { username: 'alice' },
  { username: 'bob' },
])

await rooms.seed([
  { name: 'general' },
  { name: 'support' },
])

await messages.seed([
  { roomId: 1, authorId: 1, content: 'hello general', createdAt: '2026-04-17T00:00:00.000Z' },
  { roomId: 2, authorId: 2, content: 'hello support', createdAt: '2026-04-17T00:00:01.000Z' },
])

await activity.seed([
  { roomId: 1, kind: 'system', body: 'booted', createdAt: '2026-04-17T00:00:00.000Z' },
])

const app = createApp({ adapter: db, transport, port })

app
  .flow('/todos', todos, {
    only: ['list', 'get', 'create', 'update', 'delete', 'live'],
  })
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
  .openapi({ title: 'RouteFlow Full E2E Fixture', version: '1.0.0' })
  .listen()

console.log(`[full-e2e-server] ready transport=${transport} port=${port} db=${dbPath}`)

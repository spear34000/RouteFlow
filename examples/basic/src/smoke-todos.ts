/**
 * Smoke-test the todo example by starting the real example server,
 * subscribing to /todos/live, creating a todo over REST, and verifying
 * that the live subscription receives the update.
 */

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from 'routeflow-api/client'
// @ts-ignore
import { WebSocket as NodeWebSocket } from 'ws'

if (typeof globalThis.WebSocket === 'undefined') {
  // @ts-ignore
  globalThis.WebSocket = NodeWebSocket
}

const port = 3020
const baseUrl = `http://127.0.0.1:${port}`
const smokeDbPath = './data/todos-smoke.db'

interface Todo {
  id: number
  title: string
  done: number
  createdAt: string
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/_health`)
      if (res.ok) return
    } catch {
      // server not ready yet
    }
    await delay(200)
  }
  throw new Error('todo example server did not become ready in time')
}

const child = spawn('pnpm', ['exec', 'tsx', 'examples/basic/src/server-todos.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), DB_PATH: smokeDbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
})

child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`))
child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))

const stopServer = async (): Promise<void> => {
  if (child.exitCode != null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(5_000),
  ])
  if (child.exitCode == null) child.kill('SIGKILL')
}

try {
  await waitForServer()

  const client = createClient(baseUrl, {
    reconnect: { maxAttempts: 2, initialDelayMs: 200 },
    onError: (error) => {
      console.error('[smoke] client error:', error.message)
    },
  })

  let lastPush: Todo[] | null = null
  const pushed = new Promise<Todo[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not receive live push in time')), 8_000)
    const unsubscribe = client.subscribe<Todo[]>('/todos/live', (todos) => {
      lastPush = todos
      if (todos.some((todo) => todo.title === 'Smoke test todo')) {
        clearTimeout(timer)
        unsubscribe()
        resolve(todos)
      }
    })
  })

  const before = await client.get<Todo[]>('/todos')
  console.log(`[smoke] initial todos: ${before.length}`)

  const created = await client.post<Todo>('/todos', {
    title: 'Smoke test todo',
    done: 0,
    createdAt: new Date().toISOString(),
  })
  console.log(`[smoke] created todo id=${created.id}`)

  const live = await pushed
  console.log(`[smoke] live push received with ${live.length} todos`)

  const pushedRows = lastPush as Todo[] | null
  if (!pushedRows || !pushedRows.some((todo) => todo.id === created.id)) {
    throw new Error('live payload did not include the created todo')
  }

  client.destroy()
  console.log('[smoke] todo example passed')
} finally {
  await stopServer()
  await Promise.all([
    rm(smokeDbPath, { force: true }),
    rm(`${smokeDbPath}-shm`, { force: true }),
    rm(`${smokeDbPath}-wal`, { force: true }),
  ])
}

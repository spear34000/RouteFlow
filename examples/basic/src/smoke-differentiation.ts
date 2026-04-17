import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
// @ts-ignore
import { WebSocket as NodeWebSocket } from 'ws'

const port = 3030
const baseUrl = `http://127.0.0.1:${port}`
const smokeDbPath = './data/differentiation-smoke.db'

interface ActivityDelta {
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  row: {
    id: number
    roomId: number
    kind: string
    body: string
    createdAt: string
  }
  timestamp: number
}

interface LiveMessageRow {
  id: number
  roomId: number
  authorId: number
  content: string
  author?: { id: number; username: string } | null
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/_health`)
      if (res.ok) return
    } catch {
      // retry
    }
    await delay(200)
  }
  throw new Error('differentiation example server did not become ready in time')
}

const child = spawn('pnpm', ['exec', 'tsx', 'examples/basic/src/server-differentiation.ts'], {
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

async function expectActivityDelta(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new NodeWebSocket(baseUrl.replace('http', 'ws'))
    let initialSeen = false
    const cleanup = () => ws.close()
    try {
      const timer = setTimeout(() => reject(new Error('did not receive smart delta activity push')), 8_000)
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as { type: string; data: unknown }
        if (msg.type !== 'update') return
        if (!initialSeen) {
          initialSeen = true
          void fetch(`${baseUrl}/activity`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              roomId: 1,
              kind: 'message',
              body: 'smart delta works',
              createdAt: new Date().toISOString(),
            }),
          })
          return
        }

        const delta = msg.data as ActivityDelta
        if (delta.operation === 'INSERT' && delta.row.body === 'smart delta works') {
          clearTimeout(timer)
          cleanup()
          resolve()
        }
      })
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', path: '/activity/live' }))
      })
      ws.on('error', reject)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

async function expectLiveIncludeAndQueryAware(): Promise<void> {
  const snapshotRes = await fetch(`${baseUrl}/rooms/1/messages?include=author&limit=10`)
  const snapshot = await snapshotRes.json() as LiveMessageRow[]
  if (!snapshot[0]?.author?.username) {
    throw new Error('initial snapshot did not include author relation')
  }

  await new Promise<void>((resolve, reject) => {
    const ws = new NodeWebSocket(baseUrl.replace('http', 'ws'))
    let stage: 'initial' | 'room-filter' | 'room-write' = 'initial'
    const cleanup = () => ws.close()
    try {
      const timer = setTimeout(() => reject(new Error('did not receive query-aware/live-include update')), 8_000)
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as { type: string; data: unknown }
        if (msg.type !== 'update') return

        if (stage === 'initial') {
          stage = 'room-filter'
          void fetch(`${baseUrl}/rooms/2/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              authorId: 2,
              content: 'ignore room 2',
              createdAt: new Date().toISOString(),
            }),
          })
          void delay(400).then(() => {
            if (stage !== 'room-filter') return
            stage = 'room-write'
            void fetch(`${baseUrl}/rooms/1/messages`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                authorId: 1,
                content: 'room 1 follow-up',
                createdAt: new Date().toISOString(),
              }),
            })
          })
          return
        }

        if (stage === 'room-filter') {
          clearTimeout(timer)
          reject(new Error('room 2 write incorrectly reached room 1 live subscription'))
          return
        }

        const rows = msg.data as LiveMessageRow[]
        if (Array.isArray(rows) && rows.some((row) => row.content === 'room 1 follow-up' && row.author?.username === 'alice')) {
          clearTimeout(timer)
          cleanup()
          resolve()
        }
      })
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', path: '/rooms/1/messages/live?include=author&limit=10' }))
      })
      ws.on('error', reject)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

try {
  await waitForServer()
  await expectActivityDelta()
  await expectLiveIncludeAndQueryAware()
  console.log('[smoke] differentiation example passed')
} finally {
  await stopServer()
  await Promise.all([
    rm(smokeDbPath, { force: true }),
    rm(`${smokeDbPath}-shm`, { force: true }),
    rm(`${smokeDbPath}-wal`, { force: true }),
  ])
}

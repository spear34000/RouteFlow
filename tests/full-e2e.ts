import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
// @ts-ignore
import { WebSocket as NodeWebSocket } from 'ws'

type Transport = 'websocket' | 'sse'

interface RunningServer {
  baseUrl: string
  child: ChildProcess
  dbPath: string
  transport: Transport
}

function spawnServer(transport: Transport, port: number, dbPath: string): RunningServer {
  const child = spawn('pnpm', ['exec', 'tsx', 'tests/fixtures/full-e2e-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      ROUTEFLOW_TRANSPORT: transport === 'sse' ? 'sse' : 'websocket',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => process.stdout.write(`[fixture:${transport}] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[fixture:${transport}] ${chunk}`))

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    dbPath,
    transport,
  }
}

async function waitForServer(baseUrl: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/_health`)
      if (res.ok) return
    } catch {
      // retry
    }
    await delay(200)
  }
  throw new Error(`server ${baseUrl} did not become ready in time`)
}

async function waitForServerDown(baseUrl: string): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${baseUrl}/_health`)
    } catch {
      return
    }
    await delay(200)
  }
  throw new Error(`server ${baseUrl} did not shut down in time`)
}

async function stopServer(server: RunningServer, signal: NodeJS.Signals = 'SIGTERM'): Promise<number | null> {
  if (server.child.exitCode != null) return server.child.exitCode
  server.child.kill(signal)
  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => server.child.once('exit', (code) => resolve(code))),
    delay(15_000).then(() => null),
  ])
  if (server.child.exitCode == null) server.child.kill('SIGKILL')
  return exitCode
}

async function cleanupDb(dbPath: string): Promise<void> {
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
  ])
}

async function testHealthAndOpenAPI(baseUrl: string): Promise<void> {
  const healthRes = await fetch(`${baseUrl}/_health`)
  assert.equal(healthRes.status, 200)
  const health = await healthRes.json() as { status: string }
  assert.equal(health.status, 'ok')

  const openapiRes = await fetch(`${baseUrl}/openapi.json`)
  assert.equal(openapiRes.status, 200)
  const openapi = await openapiRes.json() as { paths: Record<string, unknown> }
  assert.ok(openapi.paths['/activity/live'])
  assert.ok(Object.keys(openapi.paths).some((key) => key.includes('/messages/live')))
}

async function testRequestId(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/todos`, {
    headers: { 'X-Request-ID': 'e2e-request-id' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-request-id'), 'e2e-request-id')
}

async function testCrud(baseUrl: string): Promise<void> {
  const listBefore = await fetch(`${baseUrl}/todos`)
  const before = await listBefore.json() as Array<{ id: number }>
  assert.ok(before.length >= 1)

  const createRes = await fetch(`${baseUrl}/todos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'e2e todo',
      done: 0,
      createdAt: new Date().toISOString(),
    }),
  })
  assert.equal(createRes.status, 200)
  const created = await createRes.json() as { id: number; title: string }
  assert.equal(created.title, 'e2e todo')

  const getRes = await fetch(`${baseUrl}/todos/${created.id}`)
  assert.equal(getRes.status, 200)

  const patchRes = await fetch(`${baseUrl}/todos/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ done: 1 }),
  })
  assert.equal(patchRes.status, 200)
  const patched = await patchRes.json() as { done: number }
  assert.equal(patched.done, 1)

  const deleteRes = await fetch(`${baseUrl}/todos/${created.id}`, {
    method: 'DELETE',
  })
  assert.equal(deleteRes.status, 200)
  const deleted = await deleteRes.json() as { ok: boolean }
  assert.equal(deleted.ok, true)
}

async function testSmartDeltaOverWebSocket(baseUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new NodeWebSocket(baseUrl.replace('http', 'ws'))
    let stage: 'initial' | 'delta' = 'initial'
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('smart delta websocket update not received'))
    }, 8_000)

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { type: string; data: unknown }
      if (msg.type !== 'update') return

      if (stage === 'initial') {
        stage = 'delta'
        void fetch(`${baseUrl}/activity`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomId: 1,
            kind: 'message',
            body: 'smart delta e2e',
            createdAt: new Date().toISOString(),
          }),
        })
        return
      }

      const delta = msg.data as {
        operation: string
        row: { body: string }
      }
      if (delta.operation === 'INSERT' && delta.row.body === 'smart delta e2e') {
        clearTimeout(timer)
        ws.close()
        resolve()
      }
    })

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', path: '/activity/live' }))
    })
    ws.on('error', reject)
  })
}

async function testQueryAwareAndLiveIncludeOverWebSocket(baseUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new NodeWebSocket(baseUrl.replace('http', 'ws'))
    let stage: 'initial' | 'wrong-room' | 'room-write' = 'initial'
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('query-aware/live-include websocket update not received'))
    }, 10_000)

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { type: string; data: unknown }
      if (msg.type !== 'update') return

      if (stage === 'initial') {
        stage = 'wrong-room'
        void fetch(`${baseUrl}/rooms/2/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            authorId: 2,
            content: 'ignore support room',
            createdAt: new Date().toISOString(),
          }),
        })
        void delay(400).then(() => {
          if (stage !== 'wrong-room') return
          stage = 'room-write'
          void fetch(`${baseUrl}/rooms/1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              authorId: 1,
              content: 'room 1 e2e message',
              createdAt: new Date().toISOString(),
            }),
          })
        })
        return
      }

      if (stage === 'wrong-room') {
        clearTimeout(timer)
        ws.close()
        reject(new Error('query-aware route received a room 2 update'))
        return
      }

      const rows = msg.data as Array<{ content?: string; author?: { username: string } | null }>
      if (Array.isArray(rows) && rows.some((row) => row.content === 'room 1 e2e message' && row.author?.username === 'alice')) {
        clearTimeout(timer)
        ws.close()
        resolve()
      }
    })

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', path: '/rooms/1/messages/live?include=author&limit=10' }))
    })
    ws.on('error', reject)
  })
}

async function testSse(baseUrl: string): Promise<void> {
  const controller = new AbortController()
  const res = await fetch(
    `${baseUrl}/_sse/subscribe?path=${encodeURIComponent('/activity/live')}`,
    { signal: controller.signal },
  )
  assert.equal(res.status, 200)
  assert.ok(res.body)

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let stage: 'initial' | 'delta' = 'initial'

  const readPromise = new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error('sse update not received'))
    }, 10_000)

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')

          const dataLine = chunk
            .split('\n')
            .find((line) => line.startsWith('data: '))

          if (!dataLine) continue
          const payload = JSON.parse(dataLine.slice(6)) as { type: string; data: unknown }
          if (payload.type !== 'update') continue

          if (stage === 'initial') {
            stage = 'delta'
            void fetch(`${baseUrl}/activity`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                roomId: 1,
                kind: 'message',
                body: 'sse delta e2e',
                createdAt: new Date().toISOString(),
              }),
            })
            continue
          }

          const delta = payload.data as { operation: string; row: { body: string } }
          if (delta.operation === 'INSERT' && delta.row.body === 'sse delta e2e') {
            clearTimeout(timer)
            controller.abort()
            resolve()
            return
          }
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        resolve()
        return
      }
      reject(error)
    }
  })

  await readPromise
}

async function main(): Promise<void> {
  const wsServer = spawnServer('websocket', 3040, './data/full-e2e-ws.db')
  const sseServer = spawnServer('sse', 3041, './data/full-e2e-sse.db')

  try {
    await waitForServer(wsServer.baseUrl)
    await waitForServer(sseServer.baseUrl)

    await testHealthAndOpenAPI(wsServer.baseUrl)
    await testRequestId(wsServer.baseUrl)
    await testCrud(wsServer.baseUrl)
    await testSmartDeltaOverWebSocket(wsServer.baseUrl)
    await testQueryAwareAndLiveIncludeOverWebSocket(wsServer.baseUrl)
    await testSse(sseServer.baseUrl)

    await stopServer(wsServer, 'SIGTERM')
    await stopServer(sseServer, 'SIGTERM')
    await waitForServerDown(wsServer.baseUrl)
    await waitForServerDown(sseServer.baseUrl)

    console.log('[tests] full e2e suite passed')
  } finally {
    await Promise.all([
      stopServer(wsServer).catch(() => undefined),
      stopServer(sseServer).catch(() => undefined),
      cleanupDb(wsServer.dbPath),
      cleanupDb(sseServer.dbPath),
    ])
  }
}

await main()

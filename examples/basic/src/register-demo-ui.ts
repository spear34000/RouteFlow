import { readFile } from 'node:fs/promises'
import type { ReactiveApp } from '@routeflow/core'
import { renderDemoHtml } from './demo-page.js'

const clientModuleUrl = new URL('../../../packages/client/dist/index.mjs', import.meta.url)
type HtmlReply = { type: (contentType: string) => unknown }

export function registerDemoUi(
  app: ReactiveApp,
  options: { title: string; subtitle: string; transport: 'websocket' | 'sse' },
): void {
  const fastify = app.getFastify()

  fastify.get('/', async (_req: unknown, reply: HtmlReply) => {
    reply.type('text/html; charset=utf-8')
    return renderDemoHtml(options.title, options.subtitle, options.transport)
  })

  fastify.get('/demo-client.js', async (_req: unknown, reply: HtmlReply) => {
    reply.type('text/javascript; charset=utf-8')
    return readFile(clientModuleUrl, 'utf8')
  })
}

import { Reactive, Route, body } from 'routeflow-api'
import type { Context, TableStore } from 'routeflow-api'

// ── Schema ────────────────────────────────────────────────────────────────

export interface Item {
  id: number
  name: string
  createdAt: string
}

export const seedItems: Omit<Item, 'id'>[] = [
  { name: 'Apple',  createdAt: '2026-01-01T00:00:00.000Z' },
  { name: 'Banana', createdAt: '2026-01-01T00:00:01.000Z' },
]

// ── Controller ────────────────────────────────────────────────────────────
//
// Pass an instance to app.register() so the store is injected naturally:
//
//   const items = db.table('items', { name: 'text', createdAt: 'text' })
//   app.register(new ItemController(items))
//
// @Reactive on a non-/live route auto-registers a companion /items/live endpoint —
// no separate live handler needed.

export class ItemController {
  constructor(private readonly items: TableStore<Item>) {}

  @Route('GET', '/items')
  @Reactive({ watch: 'items' })          // → also registers GET /items/live (WS/SSE)
  async getItems(_ctx: Context): Promise<Item[]> {
    return this.items.list()
  }

  @Route('GET', '/items/:id')
  async getItem(ctx: Context): Promise<Item | { error: string }> {
    return (await this.items.get(Number(ctx.params['id']))) ?? { error: 'Not found' }
  }

  @Route('POST', '/items')
  async createItem(ctx: Context): Promise<Item> {
    const { name } = body<{ name: string }>(ctx)
    return this.items.create({ name: name ?? 'Unnamed', createdAt: new Date().toISOString() })
  }

  @Route('PUT', '/items/:id')
  async updateItem(ctx: Context): Promise<Item | { error: string }> {
    const { name } = body<{ name: string }>(ctx)
    const updated = await this.items.update(Number(ctx.params['id']), { name })
    return updated ?? { error: 'Not found' }
  }

  @Route('DELETE', '/items/:id')
  async deleteItem(ctx: Context): Promise<{ ok: boolean }> {
    return { ok: await this.items.delete(Number(ctx.params['id'])) }
  }
}

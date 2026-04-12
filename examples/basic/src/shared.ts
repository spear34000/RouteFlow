import { Reactive, Route } from 'routeflow-api'
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

// ── Controller factory ────────────────────────────────────────────────────
//
// Accepts any TableStore<Item> — works with RouteStore (SQLite),
// a custom Postgres class, or any other backend.
//
// Change events are handled at the store/adapter level:
//   • RouteStore  → create/update/delete auto-emit inside the store
//   • Other DBs   → native CDC (triggers, binlog, etc.) fires through the adapter

export function createItemController(items: TableStore<Item>) {
  class ItemController {
    @Route('GET', '/items')
    async getItems(_ctx: Context): Promise<Item[]> {
      return items.list()
    }

    @Route('GET', '/items/:id')
    async getItem(ctx: Context): Promise<Item | { error: string }> {
      const item = await items.get(Number(ctx.params['id']))
      return item ?? { error: 'Not found' }
    }

    @Route('POST', '/items')
    async createItem(ctx: Context): Promise<Item> {
      const body = (ctx.body ?? {}) as { name?: string }
      return items.create({ name: body.name ?? 'Unnamed', createdAt: new Date().toISOString() })
    }

    @Route('PUT', '/items/:id')
    async updateItem(ctx: Context): Promise<Item | { error: string }> {
      const body = (ctx.body ?? {}) as { name?: string }
      const updated = await items.update(Number(ctx.params['id']), { name: body.name })
      return updated ?? { error: 'Not found' }
    }

    @Route('DELETE', '/items/:id')
    async deleteItem(ctx: Context): Promise<{ ok: boolean }> {
      return { ok: await items.delete(Number(ctx.params['id'])) }
    }

    @Reactive({ watch: 'items' })
    @Route('GET', '/items/live')
    async getLiveItems(_ctx: Context): Promise<Item[]> {
      return items.list()
    }
  }

  return ItemController
}

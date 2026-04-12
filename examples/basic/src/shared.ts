import { Reactive, Route } from '@routeflow/core'
import type { Context } from '@routeflow/core'
import { MemoryAdapter } from '@routeflow/core/adapters'

export interface Item {
  id: number
  name: string
  createdAt: string
}

export interface ItemStore {
  list(): Promise<Item[]>
  get(id: number): Promise<Item | null>
  create(name: string): Promise<Item>
}

export interface ItemChangeEmitter {
  emitInsert(table: string, row: Item): void | Promise<void>
}

export function createItemController(store: ItemStore, emitter?: ItemChangeEmitter) {
  class ItemController {
    @Route('GET', '/items')
    async getItems(_ctx: Context): Promise<Item[]> {
      return store.list()
    }

    @Route('GET', '/items/:id')
    async getItem(ctx: Context): Promise<Item | { error: string }> {
      const item = await store.get(Number(ctx.params['id']))
      if (!item) return { error: 'Not found' }
      return item
    }

    @Route('POST', '/items')
    async createItem(ctx: Context): Promise<Item> {
      const body = (ctx.body ?? {}) as { name?: string }
      const item = await store.create(body.name ?? 'Unnamed')
      await emitter?.emitInsert('items', item)
      return item
    }

    @Reactive({ watch: 'items' })
    @Route('GET', '/items/live')
    async getLiveItems(_ctx: Context): Promise<Item[]> {
      return store.list()
    }
  }

  return ItemController
}

export class MemoryItemStore implements ItemStore {
  private items: Item[]
  private nextId: number

  constructor(seed: Item[]) {
    this.items = [...seed]
    this.nextId = (seed.at(-1)?.id ?? 0) + 1
  }

  async list(): Promise<Item[]> {
    return [...this.items]
  }

  async get(id: number): Promise<Item | null> {
    return this.items.find((item) => item.id === id) ?? null
  }

  async create(name: string): Promise<Item> {
    const item: Item = {
      id: this.nextId++,
      name,
      createdAt: new Date().toISOString(),
    }
    this.items.push(item)
    return item
  }
}

export class MemoryChangeEmitter implements ItemChangeEmitter {
  constructor(private readonly adapter: MemoryAdapter) {}

  emitInsert(table: string, row: Item): void {
    this.adapter.emit(table, {
      operation: 'INSERT',
      newRow: row,
      oldRow: null,
    })
  }
}

export const seedItems: Item[] = [
  { id: 1, name: 'Apple', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 2, name: 'Banana', createdAt: '2026-01-01T00:00:01.000Z' },
]

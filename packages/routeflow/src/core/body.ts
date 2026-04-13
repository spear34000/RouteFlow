import type { Context } from './types.js'

/**
 * Safely access the typed request body.
 *
 * Returns a `Partial<T>` so callers must handle potentially missing fields.
 * Returns `{}` if the body is absent, null, or not a plain object (e.g. an array
 * or a primitive), preventing common runtime errors from unchecked casts.
 *
 * @example
 * ```ts
 * import { body } from 'routeflow-api'
 *
 * @Route('POST', '/items')
 * async createItem(ctx: Context) {
 *   const { name } = body<{ name: string }>(ctx)
 *   return this.items.create({ name: name ?? 'Unnamed', createdAt: new Date().toISOString() })
 * }
 * ```
 */
export function body<T extends object = Record<string, unknown>>(ctx: Context): Partial<T> {
  if (ctx.body === null || ctx.body === undefined) return {} as Partial<T>
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) return {} as Partial<T>
  return ctx.body as Partial<T>
}

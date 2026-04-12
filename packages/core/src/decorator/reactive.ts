import type { ReactiveOptions } from '../types.js'

/** Symbol key used to store @Reactive metadata on a method. */
export const REACTIVE_METADATA = Symbol('reactive-api:reactive')

/**
 * Marks a route handler as reactive — when the watched table(s) change,
 * the handler is re-executed and the result is pushed to all subscribed clients.
 *
 * Must be used together with @Route.
 *
 * @param options - Reactive configuration (watch, filter, debounce)
 *
 * @example
 * ```ts
 * @Reactive({ watch: 'orders', filter: (event, ctx) => event.newRow?.userId === ctx.params.userId })
 * @Route('GET', '/orders/:userId/live')
 * async getLiveOrders(ctx: Context) { ... }
 * ```
 */
export function Reactive(options: ReactiveOptions) {
  return function (target: object, propertyKey: string): void {
    Reflect.defineMetadata(REACTIVE_METADATA, options, target, propertyKey)
  }
}

import type { HttpMethod, RouteMetadata } from '../types.js'

/** Symbol key used to store @Route metadata on a method. */
export const ROUTE_METADATA = Symbol('reactive-api:route')

/**
 * Registers a class method as an HTTP endpoint.
 *
 * @param method - HTTP verb
 * @param path   - Route path, may include Fastify-style params (e.g. '/users/:id')
 *
 * @example
 * ```ts
 * @Route('GET', '/users/:id')
 * async getUser(ctx: Context) { ... }
 * ```
 */
export function Route(method: HttpMethod, path: string) {
  return function (target: object, propertyKey: string): void {
    const metadata: RouteMetadata = { method, path }
    Reflect.defineMetadata(ROUTE_METADATA, metadata, target, propertyKey)
  }
}

import type { Context, Middleware } from '../types.js'

/** Symbol key used to store @Guard metadata on a method. */
export const GUARD_METADATA = Symbol('reactive-api:guard')

/**
 * Function-keyed store for TC39 (new-style) decorator compat.
 */
export const guardFnStore = new WeakMap<object, Middleware[]>()

/**
 * Attaches one or more middleware functions to a single route method.
 * Guards run after global `app.use()` middleware but before the route handler.
 *
 * Common uses: authentication, authorization, per-route rate limiting.
 *
 * @example
 * ```ts
 * // Inline guard
 * @Guard(async (ctx, next) => {
 *   if (!ctx.headers['authorization']) throw unauthorized()
 *   await next()
 * })
 * @Route('GET', '/admin/users')
 * async listUsers(ctx: Context) { ... }
 *
 * // Reusable guard factory
 * function requireRole(role: string): Middleware {
 *   return async (ctx, next) => {
 *     const token = ctx.headers['authorization']
 *     if (!hasRole(token, role)) throw forbidden()
 *     await next()
 *   }
 * }
 *
 * @Guard(requireRole('admin'))
 * @Route('DELETE', '/admin/users/:id')
 * async deleteUser(ctx: Context) { ... }
 * ```
 */
export function Guard(...guards: Middleware[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, propertyKey: any): void {
    if (typeof target === 'function') {
      // TC39 decorator: target is the method function itself
      guardFnStore.set(target, guards)
    } else if (typeof propertyKey === 'string') {
      // Legacy decorator: target is the prototype, propertyKey is method name
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const fn = target[propertyKey] as object
      if (fn) guardFnStore.set(fn, guards)
      if (typeof Reflect !== 'undefined' && typeof Reflect.defineMetadata === 'function') {
        Reflect.defineMetadata(GUARD_METADATA, guards, target, propertyKey)
      }
    }
  }
}

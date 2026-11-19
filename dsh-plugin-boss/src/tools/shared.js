/**
 * Shared registration helpers for the boss_* tool domains.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BossError } from '../boss/errors.js'

/** @param {unknown} data */
export const ok = (data) => ({ ok: true, data })

/** Flatten a BossError (or any failure) into a canonical tool value. @param {unknown} error */
export const failure = (error) => ({
  ok: false,
  errorKind: error instanceof BossError ? error.kind : 'internal',
  message: error instanceof BossError ? error.message : String(error),
})

/** Uniform object-rooted output with a JSON model projection. */
export const jsonOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/**
 * Build a `registerRead` bound to one context and client. Each read tool is
 * `registerRead(name, description, parameters, build)` where build returns
 * the data value; failures go through {@link failure}.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('../boss/client.js').BossClient} client
 */
export function makeRegisterRead(ctx, client) {
  return (name, description, parameters, build) => {
    ctx.tools.register(defineTool({
      name,
      description,
      parameters,
      output: jsonOutput,
      async execute(args) {
        try {
          return ok(await build(args))
        } catch (error) {
          return failure(error)
        }
      },
    }))
  }
}

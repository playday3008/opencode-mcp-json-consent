import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

/** @type {import('@opencode/plugin').Plugin.Plugin} */
export default {
  id: 'stop-fixture-inference',
  async setup(ctx) {
    await ctx.command.transform((editor) =>
      editor.add({
        name: 'fixture-call',
        async execute({ sessionID, prompt }) {
          const input = /** @type {{tool: string, delay_ms: number}} */ (
            JSON.parse(prompt.text)
          );
          let tool = (await ctx.tool.list()).find(
            (tool) => tool.id === input.tool,
          );
          const deadline = performance.now() + 5000;
          while (!tool && performance.now() < deadline) {
            await delay(20);
            tool = (await ctx.tool.list()).find(
              (tool) => tool.id === input.tool,
            );
          }
          if (!tool) {
            throw new Error(`Fixture tool is unavailable: ${input.tool}`);
          }
          const started = performance.now();
          /** @type {string | null} */
          let error = null;
          try {
            await tool.execute(
              { delay_ms: input.delay_ms },
              {
                sessionID,
                agent: /** @type {import('@opencode/plugin').Agent.ID} */ (
                  'build'
                ),
                messageID:
                  /** @type {import('@opencode/schema/session-message').SessionMessage.ID} */ (
                    'msg_fixture'
                  ),
                id: /** @type {import('@opencode/schema/tool').Tool.CallID} */ (
                  'call_fixture'
                ),
                signal: new AbortController().signal,
                progress: async () => {},
              },
            );
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
          await writeFile(
            path.join(ctx.location.project.directory, 'fixture-call.json'),
            JSON.stringify({ elapsed_ms: performance.now() - started, error }),
          );
        },
      }),
    );
    await ctx.session.hook('prompt', () => {
      throw new Error('Fixture stops before model inference');
    });
  },
};

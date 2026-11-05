import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseConfig, fingerprint, describe } from './config.js';

/**
 * @typedef {object} ServerState
 * @property {import('./config.js').Server} server
 * @property {string} hash
 * @property {unknown} decision
 */

/**
 * @typedef {object} PendingAnswer
 * @property {string} sessionID
 * @property {(value: boolean) => void} resolve
 */

const execute = promisify(execFile);

/** @type {import('@opencode/plugin').Plugin.Plugin} */
export default {
  id: 'mcp-json',
  async setup(ctx) {
    const projectDirectory = ctx.location.project.directory;
    const hasProjectDirectory =
      projectDirectory &&
      projectDirectory !== path.parse(projectDirectory).root;
    const directory = await realpath(
      hasProjectDirectory ? projectDirectory : ctx.location.directory,
    );
    const file = path.join(directory, '.mcp.json');
    /** @type {Map<string, ServerState>} */
    const states = new Map();
    const nativeServers = new Set();
    /** @type {Map<string, PendingAnswer>} */
    const pendingAnswers = new Map();
    const warnedSessions = new Set();
    const eventController = new AbortController();
    let active = true;
    let approvalStreamFailed = false;
    const streamFailureWarning =
      'MCP approval event stream failed; imported servers require review after reload';
    /** @type {Promise<void> | undefined} */
    let pendingReview;
    /** @type {string[]} */
    let warnings = [];

    /**
     * @param {string} method
     * @param {string} endpoint
     * @param {unknown} [data]
     * @returns {Promise<unknown>}
     */
    async function requestApprovalService(method, endpoint, data) {
      const args = ['api', method, endpoint];
      if (data !== undefined) {
        args.push('--data', JSON.stringify(data));
      }
      try {
        const { stdout } = await execute('opencode', args, {
          cwd: directory,
          timeout: 10000,
          maxBuffer: 524288,
        });
        return stdout.trim() ? JSON.parse(stdout).data : undefined;
      } catch {
        // CLI errors can contain request arguments; never include them in diagnostics.
        throw new Error(
          'MCP approval service is unavailable or does not own this session',
        );
      }
    }

    async function readProjectConfig() {
      try {
        return parseConfig(await readFile(file, 'utf8'), directory);
      } catch (error) {
        const fileError = /** @type {NodeJS.ErrnoException} */ (error);
        if (fileError.code === 'ENOENT') {
          return { servers: new Map(), warnings: [] };
        }
        throw error;
      }
    }

    async function refreshServers(reload = true) {
      states.clear();
      try {
        const loaded = await readProjectConfig();
        warnings = loaded.warnings;
        for (const [name, server] of loaded.servers) {
          const hash = fingerprint(directory, name, server);
          states.set(name, {
            server,
            hash,
            decision: await ctx.storage.get(hash),
          });
        }
      } catch (error) {
        states.clear();
        const failure = /** @type {Error} */ (error);
        warnings = [`Project MCP import stopped: ${failure.message}`];
      }
      if (approvalStreamFailed) {
        warnings.push(streamFailureWarning);
      }
      if (reload) {
        await ctx.mcp.reload();
      }
    }

    await refreshServers(false);
    await ctx.mcp.transform((editor) => {
      nativeServers.clear();
      for (const [name, state] of states) {
        if (editor.get(name)) {
          nativeServers.add(name);
          continue;
        }
        editor.set(name, {
          ...state.server,
          disabled: state.server.disabled || state.decision !== true,
        });
      }
    });

    async function consumeApprovalEvents() {
      for await (const event of ctx.event.subscribe({
        types: ['form.replied', 'form.cancelled', 'session.deleted'],
        signal: eventController.signal,
      })) {
        if (event.type === 'session.deleted') {
          for (const answer of pendingAnswers.values()) {
            if (answer.sessionID === event.data.sessionID) {
              answer.resolve(false);
            }
          }
          continue;
        }
        const answer = pendingAnswers.get(event.data.id);
        if (answer?.sessionID === event.data.sessionID) {
          const trusted =
            event.type === 'form.replied' &&
            event.data.answer.decision === 'trust';
          answer.resolve(trusted);
        }
      }
    }

    function failApprovalStream() {
      if (!active || approvalStreamFailed) {
        return;
      }
      approvalStreamFailed = true;
      for (const answer of pendingAnswers.values()) {
        answer.resolve(false);
      }
      warnings.push(streamFailureWarning);
    }

    const approvalEvents = consumeApprovalEvents().then(
      failApprovalStream,
      failApprovalStream,
    );

    function requireApprovalStream() {
      if (approvalStreamFailed) {
        throw new Error(
          'MCP approval event stream is unavailable; reload the plugin before reviewing',
        );
      }
    }

    /**
     * @param {string} sessionID
     * @param {string} name
     * @param {import('./config.js').Server} server
     */
    async function requestApproval(sessionID, name, server) {
      requireApprovalStream();
      const session = /** @type {{id?: string} | undefined} */ (
        await requestApprovalService('get', `/api/session/${sessionID}`)
      );
      requireApprovalStream();
      if (session?.id !== sessionID) {
        throw new Error('MCP approval service does not own this session');
      }
      const id = 'frm_' + randomBytes(16).toString('hex');
      /** @type {Promise<boolean>} */
      const answer = new Promise((resolve) => {
        pendingAnswers.set(id, { sessionID, resolve });
      });
      try {
        await requestApprovalService('post', `/api/session/${sessionID}/form`, {
          id,
          title: 'Start project MCP?',
          metadata: { kind: 'question' },
          fields: [
            {
              key: 'decision',
              type: 'string',
              title: name,
              description: describe(directory, name, server),
              required: true,
              custom: false,
              default: 'reject',
              options: [
                { value: 'reject', label: 'Reject' },
                {
                  value: 'trust',
                  label: 'Trust this definition for this project',
                },
              ],
            },
          ],
        });
        const trusted = await answer;
        requireApprovalStream();
        return trusted;
      } finally {
        pendingAnswers.delete(id);
        if (approvalStreamFailed) {
          await requestApprovalService(
            'delete',
            `/api/session/${sessionID}/form/${id}`,
          ).catch(() => {});
        }
      }
    }

    /**
     * @param {string} sessionID
     * @param {boolean} force
     */
    async function reviewServers(sessionID, force) {
      await refreshServers();
      for (const [name, state] of states) {
        if (!active || nativeServers.has(name) || state.server.disabled) {
          continue;
        }
        if (!force && state.decision !== undefined) {
          continue;
        }
        if (force) {
          state.decision = false;
          await ctx.storage.set(state.hash, false);
          await ctx.mcp.reload();
        }
        try {
          const trusted = await requestApproval(sessionID, name, state.server);
          if (!active) {
            return;
          }
          const loaded = await readProjectConfig();
          const latest = loaded.servers.get(name);
          if (!latest || fingerprint(directory, name, latest) !== state.hash) {
            await refreshServers();
            warnings.push(
              'An MCP definition changed during review; it remains unapproved. Run /mcp-review to review it again.',
            );
            break;
          }
          state.decision = trusted;
          await ctx.storage.set(state.hash, trusted);
          await ctx.mcp.reload();
        } catch {
          state.decision = false;
          await ctx.mcp.reload();
          const retry = approvalStreamFailed
            ? 'Reload the plugin before running /mcp-review again.'
            : 'Run /mcp-review to retry; check the OpenCode log if it persists.';
          warnings.push(
            `${JSON.stringify(name)} remains disabled: approval failed. ${retry}`,
          );
          break;
        }
      }
    }

    /**
     * @param {string} sessionID
     * @param {boolean} [force]
     */
    async function ensureReviewed(sessionID, force = false) {
      if (!pendingReview) {
        pendingReview = reviewServers(sessionID, force).finally(() => {
          pendingReview = undefined;
        });
      }
      await pendingReview;
      if (warnings.length) {
        await ctx.session.instructions.entry.put({
          sessionID,
          key: 'mcp-json/warnings',
          value: warnings.join('\n'),
        });
        warnedSessions.add(sessionID);
      } else if (warnedSessions.delete(sessionID)) {
        await ctx.session.instructions.entry.remove({
          sessionID,
          key: 'mcp-json/warnings',
        });
      }
    }

    await ctx.session.hook('prompt', (event) =>
      ensureReviewed(event.sessionID),
    );
    await ctx.command.transform((editor) =>
      editor.add({
        name: 'mcp-review',
        description:
          "Review or change trust decisions for this project's .mcp.json servers",
        execute: ({ sessionID }) => ensureReviewed(sessionID, true),
      }),
    );

    return async () => {
      active = false;
      const cancellations = [];
      for (const [id, answer] of pendingAnswers) {
        answer.resolve(false);
        cancellations.push(
          requestApprovalService(
            'delete',
            `/api/session/${answer.sessionID}/form/${id}`,
          ),
        );
      }
      await Promise.allSettled(cancellations);
      eventController.abort();
      await approvalEvents;
    };
  },
};

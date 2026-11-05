import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import plugin from '../src/index.js';

/**
 * @typedef {object} Request
 * @property {string} method
 * @property {string} endpoint
 * @property {{id: string}} [data]
 */
/** @typedef {import('../src/config.js').Server} Server */
/**
 * @typedef {object} Editor
 * @property {() => undefined} get
 * @property {(name: string, server: Server) => void} set
 */
/**
 * @typedef {object} Reply
 * @property {'form.replied'} type
 * @property {{id: string, sessionID: string, answer: {decision: string}}} data
 */

/** @param {import('node:test').TestContext} t */
async function createFixture(t) {
  const temporaryDirectory = path.join(tmpdir(), 'opencode');
  await mkdir(temporaryDirectory, { recursive: true });
  const directory = await mkdtemp(
    path.join(temporaryDirectory, 'mcp-json-events-'),
  );
  const requestsFile = path.join(directory, 'requests.jsonl');
  const pauseGet = path.join(directory, 'pause-get');
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(requestsFile, '');
  await writeFile(
    path.join(directory, '.mcp.json'),
    JSON.stringify({
      mcpServers: { fixture: { command: 'harmless-fixture' } },
    }),
  );
  await writeFile(
    path.join(directory, 'opencode'),
    `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const [method, endpoint, , body] = process.argv.slice(3);
appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify({
  method, endpoint, data: body ? JSON.parse(body) : undefined,
}) + '\\n');
while (method === 'get' && existsSync(${JSON.stringify(pauseGet)})) {
  await setTimeout(10);
}
console.log(JSON.stringify({ data: method === 'get' ? { id: 'test-session' } : null }));
`,
    { mode: 0o700 },
  );
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  process.env.PATH = directory + path.delimiter + (originalPath ?? '');

  /** @returns {Promise<Request[]>} */
  async function requests() {
    const contents = await readFile(requestsFile, 'utf8');
    return contents.trim()
      ? contents
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  }

  /**
   * @param {string} method
   * @param {number} [count]
   */
  async function waitForRequest(method, count = 1) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const matching = (await requests()).filter(
        (request) => request.method === method,
      );
      const request = matching[count - 1];
      if (request) {
        return request;
      }
      await delay(10);
    }
    throw new Error(`Approval bridge did not receive ${method}`);
  }

  return { directory, pauseGet, requests, waitForRequest };
}

/**
 * @param {string} directory
 * @param {'error' | 'end'} mode
 * @param {Map<string, unknown>} [storage]
 */
async function createHost(directory, mode, storage = new Map()) {
  /** @type {((editor: Editor) => void) | undefined} */
  let transform;
  /** @type {((event: {sessionID: string}) => Promise<void>) | undefined} */
  let promptHook;
  /** @type {((event: Reply | undefined) => void) | undefined} */
  let receive;
  /** @type {Map<string, Server>} */
  const servers = new Map();
  /** @type {string[]} */
  const warnings = [];
  const editor = {
    get: () => undefined,
    /**
     * @param {string} name
     * @param {Server} server
     */
    set: (name, server) => servers.set(name, server),
  };
  const context = {
    location: { directory, project: { directory } },
    storage: {
      /** @param {string} key */
      get: async (key) => storage.get(key),
      /**
       * @param {string} key
       * @param {unknown} value
       */
      set: async (key, value) => {
        storage.set(key, value);
      },
    },
    mcp: {
      /** @param {(editor: Editor) => void} callback */
      transform: async (callback) => {
        transform = callback;
        callback(editor);
      },
      reload: async () => {
        servers.clear();
        transform?.(editor);
      },
    },
    event: {
      /**
       * @param {{signal: AbortSignal}} options
       * @returns {AsyncIterable<Reply>}
       */
      async *subscribe({ signal }) {
        const stop = () => receive?.(undefined);
        signal.addEventListener('abort', stop, { once: true });
        try {
          while (!signal.aborted) {
            /** @type {Promise<Reply | undefined>} */
            const next = new Promise((resolve) => {
              receive = resolve;
            });
            const event = await next;
            if (!event) {
              if (mode === 'error' && !signal.aborted) {
                throw new Error('Injected event stream failure');
              }
              return;
            }
            yield event;
          }
        } finally {
          signal.removeEventListener('abort', stop);
        }
      },
    },
    session: {
      /**
       * @param {string} name
       * @param {(event: {sessionID: string}) => Promise<void>} callback
       */
      hook: async (name, callback) => {
        promptHook = callback;
      },
      instructions: {
        entry: {
          /** @param {{value: string}} entry */
          put: async ({ value }) => {
            warnings.push(value);
          },
          remove: async () => {},
        },
      },
    },
    command: { transform: async () => {} },
  };
  const cleanup = await plugin.setup(
    /** @type {import('@opencode/plugin').Plugin.Context} */ (
      /** @type {unknown} */ (context)
    ),
  );
  assert.ok(cleanup);
  return {
    servers,
    storage,
    warnings,
    dispose: cleanup,
    prompt() {
      assert.ok(promptHook);
      return promptHook({ sessionID: 'test-session' });
    },
    endStream() {
      receive?.(undefined);
    },
    /** @param {string} id */
    approve(id) {
      receive?.({
        type: 'form.replied',
        data: {
          id,
          sessionID: 'test-session',
          answer: { decision: 'trust' },
        },
      });
    },
  };
}

/** @param {Promise<void>} review */
async function completes(review) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    await Promise.race([
      review,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Review hung after stream failure')),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const mode of /** @type {const} */ (['error', 'end'])) {
  test(`${mode}: a dead approval stream cannot create future forms or hang prompts`, async (t) => {
    const fixture = await createFixture(t);
    const host = await createHost(fixture.directory, mode);
    try {
      host.endStream();
      await setImmediate();
      await completes(host.prompt());
      await completes(host.prompt());
      assert.equal(host.servers.get('fixture')?.disabled, true);
      assert.equal(host.storage.size, 0);
      assert.deepEqual(await fixture.requests(), []);
      assert.match(host.warnings.join(), /event stream failed.*reload/);
    } finally {
      await host.dispose();
    }
  });

  test(`${mode}: stream failure cancels active review without storing a rejection; reload restores approval`, async (t) => {
    const fixture = await createFixture(t);
    const host = await createHost(fixture.directory, mode);
    try {
      const review = host.prompt();
      const form = await fixture.waitForRequest('post');
      assert.ok(form.data);
      host.endStream();
      await completes(review);
      assert.equal(host.servers.get('fixture')?.disabled, true);
      assert.equal(host.storage.size, 0);
      const requests = await fixture.requests();
      assert.ok(requests.some((request) => request.method === 'delete'));
      await completes(host.prompt());
      assert.equal(
        (await fixture.requests()).filter(
          (request) => request.method === 'post',
        ).length,
        1,
      );
    } finally {
      await host.dispose();
    }

    const reloaded = await createHost(fixture.directory, mode, host.storage);
    try {
      const review = reloaded.prompt();
      const form = await fixture.waitForRequest('post', 2);
      assert.ok(form?.data);
      reloaded.approve(form.data.id);
      await completes(review);
      assert.equal(reloaded.servers.get('fixture')?.disabled, false);
      assert.deepEqual([...reloaded.storage.values()], [true]);
    } finally {
      await reloaded.dispose();
    }
  });
}

test('stream failure during session lookup cannot create an unanswered form', async (t) => {
  const fixture = await createFixture(t);
  const host = await createHost(fixture.directory, 'error');
  try {
    await writeFile(fixture.pauseGet, '');
    const review = host.prompt();
    await fixture.waitForRequest('get');
    host.endStream();
    await rm(fixture.pauseGet);
    await completes(review);
    assert.equal(host.storage.size, 0);
    assert.equal(
      (await fixture.requests()).some((request) => request.method === 'post'),
      false,
    );
  } finally {
    await rm(fixture.pauseGet, { force: true });
    await host.dispose();
  }
});

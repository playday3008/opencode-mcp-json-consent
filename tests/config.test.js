import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig, fingerprint, describe } from '../src/config.js';

const root = '/tmp/project';
/**
 * @param {Record<string, unknown>} servers
 * @param {NodeJS.ProcessEnv} [env]
 */
const parse = (servers, env = {}) =>
  parseConfig(JSON.stringify({ mcpServers: servers }), root, env);

test('local commands preserve arguments and resolve executable/cwd against the project', () => {
  const { servers } = parse({
    ce: {
      command: '.venv/bin/python',
      args: ['server.py'],
      cwd: 'bridge',
      env: { MODE: 'tcp' },
    },
  });
  assert.deepEqual(servers.get('ce'), {
    type: 'local',
    command: ['/tmp/project/.venv/bin/python', 'server.py'],
    cwd: '/tmp/project/bridge',
    environment: { CLAUDE_PROJECT_DIR: root, MODE: 'tcp' },
    disabled: false,
  });
  assert.equal(
    parse({ x: { command: 'uvx', args: ['mcp-nixos'] } }).servers.get('x')
      ?.command?.[0],
    'uvx',
  );
});

test('variable defaults cover both unset and empty variables, without shell evaluation', () => {
  const entry = {
    command: '${BIN:-node}',
    args: ['${ARG:-default}', '$(touch /tmp/never)'],
  };
  for (const env of [{}, { BIN: '', ARG: '' }]) {
    assert.deepEqual(parse({ x: entry }, env).servers.get('x')?.command, [
      'node',
      'default',
      '$(touch /tmp/never)',
    ]);
  }
  assert.throws(
    () => parse({ x: { command: 'node', args: ['${MISSING}'] } }),
    /MISSING/,
  );
});

test('remote servers retain headers and disabled flags; legacy SSE is not reinterpreted', () => {
  const { servers, warnings } = parse(
    {
      docs: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: '${TOKEN}' },
        disabled: true,
      },
      old: { type: 'sse', url: 'http://localhost/sse' },
    },
    { TOKEN: 'secret-token' },
  );
  assert.deepEqual(servers.get('docs'), {
    type: 'remote',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'secret-token' },
    disabled: true,
  });
  assert.equal(servers.has('old'), false);
  assert.match(warnings.join(), /SSE/);
});

test('malformed trust-boundary input fails closed without echoing configuration contents', () => {
  for (const text of [
    '{"token":"sensitive"',
    '[]',
    '{"mcpServers":[]}',
    '{"mcpServers":{"x":null}}',
  ]) {
    assert.throws(
      () => parseConfig(text, root, {}),
      (error) => error instanceof Error && !error.message.includes('sensitive'),
    );
  }
  for (const entry of [
    { command: 'node', args: 'server.js' },
    { command: '' },
    { command: 'node', env: { TOKEN: 123 } },
    { url: 'file:///etc/passwd' },
    { command: 'node', url: 'https://example.com' },
    { command: 'node', disabled: 'false' },
  ]) {
    assert.throws(() => parse({ x: entry }));
  }
  assert.throws(() => parse(JSON.parse('{"__proto__":{"command":"node"}}')));
});

test('approval fingerprints are stable but specific to project, name, and effective definition', () => {
  const server = parse({
    x: { command: 'node', env: { A: 'one', B: 'two' } },
  }).servers.get('x');
  const reordered = parse({
    x: { env: { B: 'two', A: 'one' }, command: 'node' },
  }).servers.get('x');
  assert.ok(server?.type === 'local');
  assert.ok(reordered);
  assert.equal(
    fingerprint(root, 'x', server),
    fingerprint(root, 'x', reordered),
  );
  assert.notEqual(
    fingerprint(root, 'x', server),
    fingerprint('/elsewhere', 'x', server),
  );
  assert.notEqual(
    fingerprint(root, 'x', server),
    fingerprint(root, 'y', server),
  );
  assert.notEqual(
    fingerprint(root, 'x', server),
    fingerprint(root, 'x', { ...server, command: ['other'] }),
  );
});

test('approval descriptions hide credentials while retaining launch context', () => {
  const local = parse({
    x: {
      command: 'node',
      args: [
        'server.js',
        '--api-key',
        'literal-secret',
        '--token=inline-secret',
        'env-secret',
      ],
      env: { TOKEN: 'env-secret' },
    },
  }).servers.get('x');
  const remote = parse({
    x: {
      url: 'https://user:password@example.com/mcp?token=query-secret#fragment',
      headers: { Authorization: 'Bearer header-secret' },
    },
  }).servers.get('x');
  assert.ok(local);
  assert.ok(remote);
  /** @type {[import('../src/config.js').Server, string[]][]} */
  const cases = [
    [local, ['literal-secret', 'inline-secret', 'env-secret']],
    [
      remote,
      ['user:', 'password', 'query-secret', 'header-secret', 'fragment'],
    ],
  ];
  for (const [server, secrets] of cases) {
    const text = describe(root, 'x', server);
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.ok(text.includes(root) && text.includes('Server:'));
  }
  assert.match(describe(root, 'x', local), /server\.js/);
  assert.match(describe(root, 'x', remote), /example\.com\/mcp/);
});

test('review shows non-secret environment settings and hides positional environment credentials', () => {
  const env = { API_TOKEN: 'positional-secret' };
  const server = parse(
    {
      x: {
        command: 'node',
        args: ['${API_TOKEN}'],
        env: { PATH: '/untrusted/bin', MODE: 'tcp' },
      },
    },
    env,
  ).servers.get('x');
  assert.ok(server);
  const description = describe(root, 'x', server, env);
  assert.ok(!description.includes('positional-secret'));
  assert.ok(
    description.includes('/untrusted/bin') && description.includes('tcp'),
  );
});

test('malformed URL arguments cannot leak credentials through a formatting error', () => {
  const server = parse({
    x: { command: 'node', args: ['https://user:private-password@['] },
  }).servers.get('x');
  assert.ok(server);
  assert.ok(!describe(root, 'x', server).includes('private-password'));
});

test('unsupported authentication and tool restrictions skip only the affected server', () => {
  for (const field of [
    'headersHelper',
    'apiKeyHelper',
    'oauth',
    'auth',
    'allowedTools',
    'disabledTools',
    'excludeTools',
  ]) {
    for (const transport of [
      { command: 'node' },
      { type: 'http', url: 'https://example.com/mcp' },
    ]) {
      const { servers, warnings } = parse({
        affected: { ...transport, [field]: 'private-setting' },
        supported: { command: 'node' },
      });
      assert.equal(servers.has('affected'), false, field);
      assert.equal(servers.has('supported'), true);
      assert.match(warnings.join(), /unsupported.*fields/i);
      assert.ok(!warnings.join().includes('private-setting'));
    }
  }
});

test('unknown extensions and fields for the wrong transport are not silently discarded', () => {
  for (const entry of [
    { command: 'node', extension: 'custom' },
    { command: 'node', headers: { Authorization: 'private-header' } },
    { url: 'https://example.com/mcp', env: { TOKEN: 'private-env' } },
    { url: 'https://example.com/mcp', args: [] },
    { url: 'https://example.com/mcp', cwd: '.' },
  ]) {
    const { servers, warnings } = parse({ affected: entry });
    assert.equal(servers.size, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings.join(), /unsupported.*fields/i);
    assert.ok(!warnings.join().includes('private-'));
  }
});

test('malformed environment references fail closed in every expanded field', () => {
  for (const reference of [
    '${',
    '${TOKEN',
    '${}',
    '${ TOKEN}',
    '${2TOKEN}',
    '${TOKEN-default}',
    '${TOKEN:+other}',
    '${TOKEN:-${OTHER}}',
    '${TOKEN:-private-fallback',
  ]) {
    for (const entry of [
      { command: reference },
      { command: 'node', args: [reference] },
      { command: 'node', cwd: reference },
      { command: 'node', env: { VALUE: reference } },
      { url: `https://example.com/${reference}` },
      { url: 'https://example.com/mcp', headers: { Authorization: reference } },
    ]) {
      assert.throws(
        () => parse({ x: entry }, { TOKEN: 'present' }),
        (error) =>
          error instanceof Error &&
          /Malformed MCP environment reference/.test(error.message) &&
          !error.message.includes('private-fallback'),
        reference,
      );
    }
  }
});

test('expansion stays non-recursive and preserves literal default text', () => {
  const { servers } = parse(
    {
      x: {
        command: 'node',
        args: ['${TOKEN}', '${EMPTY:-}', '${MISSING:-$literal}', '$VAR'],
      },
    },
    { TOKEN: '${OTHER}', EMPTY: '', OTHER: 'not-expanded' },
  );
  assert.deepEqual(servers.get('x')?.command, [
    'node',
    '${OTHER}',
    '',
    '$literal',
    '$VAR',
  ]);
});

test('HTTP header validation rejects invalid names and expanded values without leaking them', () => {
  for (const headers of [
    { 'private header': 'value' },
    { 'private\r\nheader': 'value' },
    { '': 'value' },
    { Authorization: '${TOKEN}' },
    { Authorization: 'private\u0000token' },
    { Authorization: 'private\u007ftoken' },
    { Authorization: 'private\u0100token' },
  ]) {
    assert.throws(
      () =>
        parse(
          { x: { url: 'https://example.com/mcp', headers } },
          { TOKEN: 'private\r\ntoken' },
        ),
      (error) =>
        error instanceof Error &&
        /Invalid MCP HTTP header/.test(error.message) &&
        !error.message.includes('private'),
    );
  }
});

test('HTTP header validation preserves valid punctuation, tabs, empty values, and Latin-1', () => {
  const headers = { 'X-Custom!': 'one\ttwo', Empty: '', 'X-Latin': '\u00e9' };
  assert.deepEqual(
    parse({ x: { url: 'https://example.com/mcp', headers } }).servers.get('x')
      ?.headers,
    headers,
  );
});

test('local servers receive the project root without changing process interpolation', () => {
  const env = { CLAUDE_PROJECT_DIR: '/service-context' };
  const server = parse(
    { x: { command: 'node', args: ['${CLAUDE_PROJECT_DIR}'] } },
    env,
  ).servers.get('x');
  assert.ok(server);
  assert.equal(server.environment?.CLAUDE_PROJECT_DIR, root);
  assert.deepEqual(server.command, ['node', '/service-context']);
  assert.equal(env.CLAUDE_PROJECT_DIR, '/service-context');
  assert.throws(
    () => parse({ x: { command: 'node', args: ['${CLAUDE_PROJECT_DIR}'] } }),
    /Missing environment variable: CLAUDE_PROJECT_DIR/,
  );
  assert.equal(
    parse({ x: { url: 'https://example.com/mcp' } }).servers.get('x')
      ?.environment,
    undefined,
  );
});

test('explicit project-directory environment values win, including empty strings', () => {
  for (const value of ['/explicit-root', '']) {
    const server = parse({
      x: { command: 'node', env: { CLAUDE_PROJECT_DIR: value } },
    }).servers.get('x');
    assert.ok(server);
    assert.equal(server.environment?.CLAUDE_PROJECT_DIR, value);
    assert.ok(
      describe(root, 'x', server, {}).includes(
        `"CLAUDE_PROJECT_DIR":${JSON.stringify(value)}`,
      ),
    );
  }
  assert.throws(
    () =>
      parse({
        x: {
          command: 'node',
          env: { CLAUDE_PROJECT_DIR: '/explicit-root' },
          args: ['${CLAUDE_PROJECT_DIR}'],
        },
      }),
    /Missing environment variable: CLAUDE_PROJECT_DIR/,
  );
});

test('approval hashes and review include the effective project-directory environment', () => {
  const injected = parse({ x: { command: 'node' } }).servers.get('x');
  const explicit = parse({
    x: { command: 'node', env: { CLAUDE_PROJECT_DIR: root } },
  }).servers.get('x');
  const overridden = parse({
    x: { command: 'node', env: { CLAUDE_PROJECT_DIR: '/different-root' } },
  }).servers.get('x');
  assert.ok(injected && explicit && overridden);
  assert.equal(
    fingerprint(root, 'x', injected),
    fingerprint(root, 'x', explicit),
  );
  assert.notEqual(
    fingerprint(root, 'x', injected),
    fingerprint(root, 'x', overridden),
  );
  assert.ok(
    describe(root, 'x', injected, {}).includes(
      `"CLAUDE_PROJECT_DIR":"${root}"`,
    ),
  );
});

test('source tool timeouts map to OpenCode execution timeouts for both transports', () => {
  for (const timeout of [1000, 600000, 2147483647]) {
    const { servers, warnings } = parse({
      local: { command: 'node', timeout },
      remote: { url: 'https://example.com/mcp', timeout },
    });
    assert.deepEqual(warnings, []);
    for (const server of servers.values()) {
      assert.deepEqual(server.timeout, { execution: timeout });
      assert.match(
        describe(root, 'x', server, {}),
        new RegExp(`OpenCode execution timeout: ${timeout} ms`),
      );
    }
    assert.equal(servers.size, 2);
  }
});

test('invalid source timeouts fail closed instead of triggering different fallback semantics', () => {
  for (const timeout of [
    0,
    -1,
    999,
    1000.5,
    2147483648,
    Number.MAX_SAFE_INTEGER,
    '1000',
    null,
    true,
    { execution: 1000 },
  ]) {
    for (const transport of [
      { command: 'node' },
      { url: 'https://example.com/mcp' },
    ]) {
      assert.throws(
        () => parse({ x: { ...transport, timeout } }),
        /MCP timeout must be an integer from 1000 through 2147483647 ms/,
      );
    }
  }
});

test('omitted timeouts stay omitted and explicit timeout changes invalidate approval', () => {
  const original = parse({ x: { command: 'node' } }).servers.get('x');
  const short = parse({ x: { command: 'node', timeout: 1000 } }).servers.get(
    'x',
  );
  const longer = parse({ x: { command: 'node', timeout: 2000 } }).servers.get(
    'x',
  );
  assert.ok(original && short && longer);
  assert.equal(Object.hasOwn(original, 'timeout'), false);
  assert.notEqual(
    fingerprint(root, 'x', original),
    fingerprint(root, 'x', short),
  );
  assert.notEqual(
    fingerprint(root, 'x', short),
    fingerprint(root, 'x', longer),
  );
});

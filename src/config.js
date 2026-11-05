import { createHash } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import path from 'node:path';

/**
 * @typedef {object} LocalServer
 * @property {'local'} type
 * @property {string[]} command
 * @property {string} cwd
 * @property {Record<string, string>} environment
 * @property {boolean} disabled
 * @property {{execution: number}} [timeout]
 * @property {never} [url]
 * @property {never} [headers]
 */

/**
 * @typedef {object} RemoteServer
 * @property {'remote'} type
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {boolean} disabled
 * @property {{execution: number}} [timeout]
 * @property {never} [command]
 * @property {never} [cwd]
 * @property {never} [environment]
 */

/** @typedef {LocalServer | RemoteServer} Server */

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Convert Claude-style project definitions without starting any server.
 * Entries with unsupported fields are skipped with a warning, including unknown extensions.
 * Source tool timeouts map to OpenCode execution timeouts for tools, prompts, and resources.
 * @param {string} text
 * @param {string} directory
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{servers: Map<string, Server>, warnings: string[]}}
 */
export function parseConfig(text, directory, env = process.env) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('Invalid .mcp.json JSON');
  }
  const config = requireObject(document, '.mcp.json');
  const entries = requireObject(config.mcpServers ?? {}, 'mcpServers');
  /** @type {Map<string, Server>} */
  const servers = new Map();
  const warnings = [];

  /** @param {unknown} value */
  const expandString = (value) => {
    if (typeof value !== 'string') {
      throw new Error('MCP strings must be strings');
    }
    return value.replace(
      /\$\{([^}]*)(?:\}|$)/g,
      (/** @type {string} */ reference, /** @type {string} */ expression) => {
        const variable = expression.match(
          /^([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*))?$/,
        );
        if (
          !reference.endsWith('}') ||
          !variable ||
          expression.includes('${')
        ) {
          throw new Error('Malformed MCP environment reference');
        }
        const key = /** @type {string} */ (variable[1]);
        const fallback = variable[2];
        const result = fallback !== undefined ? env[key] || fallback : env[key];
        if (result === undefined) {
          throw new Error(`Missing environment variable: ${key}`);
        }
        return result;
      },
    );
  };

  /**
   * @param {unknown} value
   * @param {string} label
   */
  function expandRecord(value, label) {
    const entries = Object.entries(requireObject(value ?? {}, label));
    const expanded = entries.map(([key, item]) => [key, expandString(item)]);
    return Object.fromEntries(expanded);
  }

  for (const [name, value] of Object.entries(entries)) {
    if (
      !name.trim() ||
      /[\x00-\x1f\x7f]/.test(name) ||
      ['__proto__', 'constructor', 'prototype'].includes(name)
    ) {
      throw new Error('Invalid MCP server name');
    }
    const entry = requireObject(value, 'MCP server');
    const transport = entry.type;
    if (transport === 'sse') {
      warnings.push(
        `${JSON.stringify(name)}: legacy SSE is unsupported; configure a compatible transport explicitly`,
      );
      continue;
    }
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') {
      throw new Error('MCP disabled must be boolean');
    }
    const disabled = entry.disabled ?? false;
    const isLocal = entry.command !== undefined;
    if (isLocal) {
      if (
        entry.url !== undefined ||
        (transport !== undefined && transport !== 'stdio')
      ) {
        throw new Error('Conflicting MCP transport fields');
      }
    } else if (
      transport !== undefined &&
      transport !== 'http' &&
      transport !== 'streamable-http'
    ) {
      throw new Error('Unsupported MCP transport');
    }

    const supportedFields = isLocal
      ? ['type', 'disabled', 'command', 'args', 'cwd', 'env', 'timeout']
      : ['type', 'disabled', 'url', 'headers', 'timeout'];
    if (Object.keys(entry).some((field) => !supportedFields.includes(field))) {
      warnings.push(
        `${JSON.stringify(name)}: unsupported MCP server fields; entry not imported`,
      );
      continue;
    }

    const timeout = entry.timeout;
    if (
      timeout !== undefined &&
      (typeof timeout !== 'number' ||
        !Number.isInteger(timeout) ||
        timeout < 1000 ||
        timeout > 2147483647)
    ) {
      throw new Error(
        'MCP timeout must be an integer from 1000 through 2147483647 ms',
      );
    }
    const timeouts =
      timeout === undefined ? {} : { timeout: { execution: timeout } };

    if (isLocal) {
      let command = expandString(entry.command);
      if (!command.trim()) {
        throw new Error('MCP command must not be empty');
      }
      if (!path.isAbsolute(command) && /[/\\]/.test(command)) {
        command = path.resolve(directory, command);
      }
      if (entry.args !== undefined && !Array.isArray(entry.args)) {
        throw new Error('MCP args must be an array');
      }
      servers.set(name, {
        type: 'local',
        command: [command, ...(entry.args ?? []).map(expandString)],
        cwd: path.resolve(directory, expandString(entry.cwd ?? '.')),
        environment: {
          CLAUDE_PROJECT_DIR: directory,
          ...expandRecord(entry.env, 'MCP env'),
        },
        ...timeouts,
        disabled,
      });
    } else {
      const url = expandString(entry.url);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('Invalid MCP URL');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('MCP URL must use HTTP or HTTPS');
      }
      const headers = expandRecord(entry.headers, 'MCP headers');
      for (const [name, value] of Object.entries(headers)) {
        try {
          validateHeaderName(name);
          validateHeaderValue(name, value);
        } catch {
          throw new Error('Invalid MCP HTTP header');
        }
      }
      servers.set(name, {
        type: 'remote',
        url,
        headers,
        ...timeouts,
        disabled,
      });
    }
  }
  return { servers, warnings };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const properties = /** @type {Record<string, unknown>} */ (value);
    const sortedKeys = Object.keys(properties).sort();
    const entries = sortedKeys.map((key) => [
      key,
      canonicalize(properties[key]),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Fingerprint the project, server name, and expanded configuration, never storing raw credentials.
 * @param {string} directory
 * @param {string} name
 * @param {Server} server
 */
export function fingerprint(directory, name, server) {
  // shortcut: mutable packages and scripts are not pinned by this hash; pin their versions when needed.
  const definition = canonicalize([directory, name, server]);
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

/**
 * Display launch context while hiding credential values and common credential arguments.
 * @param {string} directory
 * @param {string} name
 * @param {Server} server
 * @param {NodeJS.ProcessEnv} [env]
 */
export function describe(directory, name, server, env = process.env) {
  const sensitive =
    /password|token|secret|api[-_]?key|authorization|credential/i;
  const environmentSecrets = Object.entries({ ...env, ...server.environment })
    .filter(([key]) => sensitive.test(key))
    .map(([, value]) => value);
  const secrets = [
    ...environmentSecrets,
    ...Object.values(server.headers ?? {}),
  ]
    .filter(/** @returns {value is string} */ (value) => !!value)
    .sort((a, b) => b.length - a.length);

  /** @param {string} value */
  const redact = (value) => {
    let result = value;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(result)) {
      let url;
      try {
        url = new URL(result);
      } catch {
        return '<redacted invalid URL>';
      }
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      result = url.toString();
    }
    for (const secret of secrets) {
      result = result.split(secret).join('<redacted>');
    }
    return result;
  };

  let redactNextArgument = false;
  const command = server.command?.map((argument) => {
    if (redactNextArgument) {
      redactNextArgument = false;
      return '<redacted>';
    }
    const pair = argument.match(/^([^=:]+)[=:](.*)$/s);
    const key = pair?.[1];
    if (key !== undefined && sensitive.test(key)) {
      return `${key}=<redacted>`;
    }
    if (/^--?/.test(argument) && sensitive.test(argument)) {
      redactNextArgument = true;
      return argument;
    }
    return redact(argument);
  });

  const redactedEnvironment = Object.entries(server.environment ?? {}).map(
    ([key, value]) => [key, sensitive.test(key) ? '<redacted>' : redact(value)],
  );
  const environmentDescription = JSON.stringify(
    Object.fromEntries(redactedEnvironment),
  );
  let launchDescription;
  if (command) {
    launchDescription = `Command: ${JSON.stringify(command)}`;
  } else {
    const url = /** @type {string} */ (server.url);
    launchDescription = `URL: ${JSON.stringify(redact(url))}`;
  }

  return [
    `Project: ${JSON.stringify(directory)}`,
    `Server: ${JSON.stringify(name)}`,
    launchDescription,
    ...(server.cwd ? [`Working directory: ${JSON.stringify(server.cwd)}`] : []),
    `Environment: ${environmentDescription}`,
    `Header names: ${JSON.stringify(Object.keys(server.headers ?? {}))}`,
    ...(server.timeout
      ? [
          `OpenCode execution timeout: ${server.timeout.execution} ms (tools, prompts, resources)`,
        ]
      : []),
    'Trust is shared by sessions in this project and covers this exact definition, not future changes to package or script contents.',
  ].join(' | ');
}

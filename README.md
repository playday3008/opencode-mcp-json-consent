# opencode-mcp-json-consent

Import a project's `.mcp.json` into OpenCode V2, with approval before starting local servers or connecting to remote servers. Native OpenCode definitions with the same name take precedence.

This package is not published to npm yet.

## Installation

Use OpenCode's managed shared service. The plugin invokes `opencode api` through `PATH` to create native approval forms; that command must reach the service that owns the session. Standalone mode and arbitrary explicit-server configurations are not supported.

### Git tag (recommended)

Add this entry to `plugins` in your global or project `opencode.jsonc`, preserving other settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:playday3008/opencode-mcp-json-consent#v0.1.0"],
}
```

OpenCode fetches and caches the Git package. No manual clone, local npm installation, or npm registry publication is needed. For a stricter source pin, replace `#v0.1.0` with a full commit hash; Git tags can be moved.

### CI artifact or local tarball

Download the `opencode-mcp-json-consent-<commit>` artifact from a GitHub Actions run whose OpenCode 2.2.5 job passed, and extract the ZIP to obtain the installable `.tgz`. CI uploads the exact package installed and tested by that job. Artifacts are retained for 14 days and remain available if the latest-version compatibility job fails.

Alternatively, build the package from a clone of this repository:

```sh
npm pack
```

Install the downloaded or locally built tarball:

```sh
npm install --prefix /absolute/path/to/plugin-install --omit=dev --ignore-scripts /path/to/opencode-mcp-json-consent-0.1.0.tgz
```

Add the installed directory to `plugins` in your global or project `opencode.jsonc`, preserving other settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/plugin-install/node_modules/opencode-mcp-json-consent",
  ],
}
```

## Review and revocation

The plugin reads `.mcp.json` from the project root, or the current location when OpenCode has no project root. New definitions remain disabled until review on the next prompt. The native form defaults to **Reject**.

Approval and rejection are remembered by project, server name, and effective converted definition. Decisions survive service restarts. Changing a definition requires fresh approval.

Run `/mcp-review` to reconsider decisions. Existing approval is revoked before that server's form appears. Reject or dismiss the form to leave the server disabled.

Definitions refresh at plugin setup, the next prompt, or manual review. There is no continuous file watcher: editing the file does not immediately stop an already running server.

## Source configuration

```json
{
  "mcpServers": {
    "local-example": {
      "command": "node",
      "args": ["server.js"],
      "cwd": "tools",
      "env": { "MODE": "read-only" },
      "timeout": 600000
    },
    "remote-example": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

| Transport   | Supported fields                                                                        |
| ----------- | --------------------------------------------------------------------------------------- |
| Local stdio | `type` (optional, `stdio`), `command`, `args`, `cwd`, `env`, `disabled`, `timeout`      |
| HTTP        | `type` (optional, `http` or `streamable-http`), `url`, `headers`, `disabled`, `timeout` |

Relative executable paths containing a slash and relative `cwd` values resolve from the project root. Arguments are passed unchanged apart from variable expansion; the example's `server.js` therefore resolves in the server's working directory.

String values support `${NAME}` and `${NAME:-default}` against the plugin process environment. A default applies to unset or empty variables. Expansion is non-recursive and never evaluates shell expressions. Missing variables without defaults, malformed references, invalid headers, and malformed configuration stop imports without echoing their values.

Local servers receive `CLAUDE_PROJECT_DIR` set to the project root. An explicit server `env.CLAUDE_PROJECT_DIR` wins, including an empty string. This injected value does not become available to interpolation. Native-looking `{env:NAME}` and `{file:path}` text remains literal in imported values.

`timeout` must be an integer from **1000 through 2147483647 milliseconds**. It maps to OpenCode's `timeout.execution`, which also covers prompt retrieval and resource reads. Explicit limits appear in review and affect the approval hash. This is not full Claude timeout emulation: startup/catalog limits are unchanged, Claude's environment and idle timers are not imported, and multi-round protocol behavior may differ. Omitted values use OpenCode runtime defaults; native `mcp.timeout` defaults are not merged into imported entries in the tested version.

Unsupported fields, including authentication helpers, source OAuth settings, tool restrictions, and unknown extensions, cause the affected entry to be skipped with a warning. Legacy SSE is also skipped. Use native OpenCode configuration for unsupported features. Remote servers still use OpenCode's native OAuth defaults; this plugin does not import account credentials.

## Security boundaries

Approval permits launching or connecting. It is not a sandbox, tool allowlist, or package integrity check. Local servers inherit OpenCode's process environment, which can contain credentials.

Hashes cover the explicit converted definition, not mutable script/package contents, every inherited environment value, OAuth credentials, or another trusted plugin's later changes. Pin package versions and review server code separately when needed.

Review text hides header values and heuristically redacts credentials elsewhere. Redaction is not comprehensive secret detection. An approval-event stream failure disables new reviews until the plugin is reloaded; it does not revoke previously approved definitions. Pending forms are cancelled on a best-effort basis.

The Web client may offer custom input despite `custom: false`. Backend validation rejects undeclared answers; the declared `trust` value is valid regardless of input control.

## Verification and development

Tested with OpenCode **2.2.5** on Fedora Linux x86-64. Manual package checks confirmed CLI and Web approval through managed-service discovery. Other versions, platforms, and service modes are not verified. The package has no runtime dependencies. Development uses Node.js from `.node-version`, Python 3.12 or later, and uv.

Local baseline checks use OpenCode 2.2.5 on `PATH`. CI tests both 2.2.5 and the latest stable CLI on pushes, pull requests, and a weekly schedule. Each job installs its CLI separately and logs the resolved version; project dependency pins stay unchanged. Latest-version failures fail the workflow but do not cancel the baseline job or block its package artifact.

```sh
npm ci
uv sync --locked
npm run check
npm run test:integration
```

Integration checks pack and install the tarball without development dependencies, use isolated HOME/XDG directories and a persistent test database, and run harmless local/HTTP fixtures without model inference. They cover approval/rejection, restart persistence, project isolation, revocation, stale definitions, concurrency, and transport settings. Generated `tests/artifacts/run-*` directories are ignored and retained for diagnostics.

The automated suite redirects approval CLI requests to its isolated server. The manual CLI/Web checks use normal managed-service discovery.

MIT license. Author: PlayDay.

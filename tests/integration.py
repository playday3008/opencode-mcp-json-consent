import base64
import json
import os
import re
import secrets
import selectors
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Literal, TypedDict, cast
from urllib.parse import parse_qs, urlencode, urlsplit


class ServerDefinition(TypedDict, total=False):
    command: str
    args: list[str]
    url: str
    disabled: bool
    type: str
    cwd: str
    env: dict[str, str]
    headers: dict[str, str]
    timeout: int


class ProjectDefinition(TypedDict):
    mcpServers: dict[str, ServerDefinition]


class FormOption(TypedDict):
    value: str


class FormField(TypedDict):
    default: str
    custom: bool
    description: str
    options: list[FormOption]


class Form(TypedDict):
    sessionID: str
    id: str
    metadata: dict[str, str]
    fields: list[FormField]


class SessionInfo(TypedDict):
    id: str


class ApiResponse(TypedDict, total=False):
    data: list[Form] | SessionInfo
    httpError: int
    body: str


class Permission(TypedDict):
    action: str
    resource: str
    effect: str


class LaunchContext(TypedDict):
    executable: str
    args: list[str]
    cwd: str
    environment: dict[str, str | None]


class CallOutcome(TypedDict):
    elapsed_ms: float
    error: str | None


class HttpRequest(TypedDict):
    path: str
    headers: dict[str, str]


tests_directory = Path(__file__).parent
source = Path(__file__).resolve().parents[1]
fixtures = tests_directory / "fixtures"
fixture_script = fixtures / "fixture.py"
artifacts = tests_directory / "artifacts"
artifacts.mkdir(exist_ok=True)
root = Path(tempfile.mkdtemp(prefix="run-", dir=artifacts))
project = root / "project"
project.mkdir()
subprocess.run(["git", "init", "-q", str(project)], check=True)
(project / "nested").mkdir()
(project / "bridge").mkdir()
marker = project / "started.txt"
launch_context = Path(str(marker) + ".context.json")
progress_file = Path(str(marker) + ".progress")
project_config = project / ".mcp.json"

definition: ProjectDefinition = {
    "mcpServers": {
        "fixture": {
            "command": sys.executable,
            "args": [
                str(fixture_script),
                str(marker),
                "${FIXTURE_PROCESS_VALUE}",
                "{env:FIXTURE_NATIVE_VALUE}",
                "{file:fixture-secret.txt}",
            ],
            "cwd": "bridge",
            "env": {
                "FIXTURE_VALUE": "${FIXTURE_PROCESS_VALUE}",
                "FIXTURE_LITERAL": "{env:FIXTURE_NATIVE_VALUE}",
                "FIXTURE_FILE": "{file:fixture-secret.txt}",
            },
            "timeout": 1000,
        },
        "native-protected": {
            "command": sys.executable,
            "args": [str(fixture_script), str(project / "shadowed.txt")],
        },
        "disabled-doc": {"url": "http://127.0.0.1:1/mcp", "disabled": True},
        "old-sse": {"type": "sse", "url": "http://127.0.0.1:1/sse"},
    }
}
project_config.write_text(json.dumps(definition))

env = os.environ.copy()
for key in [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
]:
    directory = root / key.lower()
    directory.mkdir()
    env[key] = str(directory)
env.pop("OPENCODE_SESSION_ID", None)
password = secrets.token_urlsafe(24)
env["OPENCODE_PASSWORD"] = password
env["OPENCODE_DB"] = str(root / "opencode.sqlite")
env["CLAUDE_PROJECT_DIR"] = "/service-context"
env["FIXTURE_PROCESS_VALUE"] = "process-value"
env["FIXTURE_NATIVE_VALUE"] = "must-not-expand"

with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
opencode_binary = shutil.which("opencode")
assert opencode_binary is not None, "opencode must be on PATH"

bridge = root / "bin"
bridge.mkdir()
bridge_failure = root / "bridge-failure"
bridge_script = bridge / "opencode"
bridge_contents = (
    "#!/bin/sh\n"
    f"test ! -e {shlex.quote(str(bridge_failure))} || exit 1\n"
    f'exec {shlex.quote(opencode_binary)} "$@" --server http://127.0.0.1:{port}\n'
)
bridge_script.write_text(bridge_contents)
bridge_script.chmod(0o700)
env["PATH"] = str(bridge) + os.pathsep + env["PATH"]

global_config = Path(env["XDG_CONFIG_HOME"]) / "opencode"
global_config.mkdir()
package_metadata = json.loads((source / "package.json").read_text())
packed = subprocess.run(
    ["npm", "pack", "--json", "--pack-destination", str(root)],
    cwd=source,
    env=env,
    text=True,
    capture_output=True,
    check=True,
)
archive_info = json.loads(packed.stdout)[0]
archive = root / archive_info["filename"]
package_files = {entry["path"] for entry in archive_info["files"]}
required_files = {"src/index.js", "src/config.js", "package.json", "LICENSE"}
assert required_files <= package_files <= required_files | {"README.md"}, package_files
print("PASS: packed archive contains only intended release files", flush=True)
installation = root / "package-install"
subprocess.run(
    [
        "npm",
        "install",
        "--prefix",
        str(installation),
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        str(archive),
    ],
    env=env,
    check=True,
)
installed = installation / "node_modules" / package_metadata["name"]
assert installed.is_dir() and not installed.is_symlink()
assert not (global_config / "plugins").exists(), "Adapter must not also auto-load"

opencode_config = {
    "plugins": [str(installed), str(fixtures / "stop")],
    "formatter": False,
    "snapshots": False,
    "mcp": {
        "servers": {
            "native-protected": {
                "type": "local",
                "command": [
                    sys.executable,
                    str(fixture_script),
                    str(project / "native.txt"),
                ],
                "disabled": True,
            }
        }
    },
    "permissions": [
        {"action": "fixture_mcp.start", "resource": "*", "effect": "ask"},
        {"action": "fixture_probe", "resource": "*", "effect": "allow"},
        {"action": "fixture-http_probe", "resource": "*", "effect": "allow"},
    ],
}
(global_config / "opencode.json").write_text(json.dumps(opencode_config))


def start_server() -> tuple[subprocess.Popen[str], selectors.DefaultSelector, str]:
    assert opencode_binary is not None
    process = subprocess.Popen(
        [opencode_binary, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
        env=env,
        cwd=project,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    selector = selectors.DefaultSelector()
    assert process.stdout is not None
    selector.register(process.stdout, selectors.EVENT_READ)
    for _ in range(30):
        if not selector.select(1):
            continue
        line = process.stdout.readline()
        match = re.search(r"http://127\.0\.0\.1:\d+", line)
        if match:
            return process, selector, match[0]
        assert process.poll() is None, line
    raise AssertionError("Isolated server did not start")


process, selector, url = start_server()
pool = ThreadPoolExecutor(max_workers=3)
credentials = ("opencode:" + password).encode()
encoded_credentials = base64.b64encode(credentials).decode()
authorization = "Basic " + encoded_credentials
sessions: list[str] = []
http_process: subprocess.Popen[str] | None = None


def api(method: str, endpoint: str, data: object = None) -> ApiResponse | None:
    assert url is not None
    request_body = None
    if data is not None:
        request_body = json.dumps(data).encode()

    request = urllib.request.Request(
        url + endpoint,
        method=method,
        data=request_body,
        headers={"Authorization": authorization, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            body = response.read()
            if not body:
                return None
            return cast(ApiResponse, json.loads(body))
    except urllib.error.HTTPError as error:
        return {"httpError": error.code, "body": error.read().decode()}


def wait_for[T](
    predicate: Callable[[], T | None | Literal[False]], description: str
) -> T:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    if "prompt" in globals():
        print("Prompt completed:", prompt.done(), flush=True)
        if prompt.done():
            print("Prompt response:", prompt.result(), flush=True)
    raise AssertionError(description)


def forms() -> list[Form]:
    pending: list[Form] = []
    for session_id in sessions:
        result = api("GET", f"/api/session/{session_id}/form")
        assert result is not None and "httpError" not in result, result
        session_forms = cast(list[Form], result.get("data", []))
        pending.extend(session_forms)
    return pending


def form() -> Form | None:
    pending = forms()
    if not pending:
        return None
    return pending[0]


def start_count() -> int:
    if not marker.exists():
        return 0
    starts = marker.read_text().splitlines()
    return len(starts)


def reply(request: Form, decision: str) -> None:
    session_id = request["sessionID"]
    form_id = request["id"]
    endpoint = f"/api/session/{session_id}/form/{form_id}/reply"
    answer = {"answer": {"decision": decision}}
    result = api("POST", endpoint, answer)
    assert result is None or "httpError" not in result, result


def session(
    title: str,
    permissions: list[Permission] | None = None,
    directory: Path | None = None,
) -> str:
    body: dict[str, object] = {
        "title": title,
        "location": {"directory": str(directory or project / "nested")},
    }
    if permissions is not None:
        body["permissions"] = permissions
    result = api("POST", "/api/session", body)
    assert result is not None and "httpError" not in result, result
    session_info = cast(SessionInfo, result.get("data", result))
    session_id = session_info["id"]
    sessions.append(session_id)
    return session_id


def prompt_for(session_id: str, text: str) -> Future[ApiResponse | None]:
    endpoint = f"/api/session/{session_id}/prompt"
    return pool.submit(api, "POST", endpoint, {"text": text})


def change_definition(revision: str) -> None:
    fixture_definition = definition["mcpServers"]["fixture"]
    original_args = fixture_definition["args"]
    fixture_definition["args"] = original_args[:2] + [revision]
    project_config.write_text(json.dumps(definition))


def review_for(session_id: str) -> Future[ApiResponse | None]:
    endpoint = f"/api/session/{session_id}/command"
    return pool.submit(
        api,
        "POST",
        endpoint,
        {"name": "mcp-review", "text": ""},
    )


def call_fixture(session_id: str, tool: str, delay_ms: int) -> CallOutcome:
    outcome_file = project / "fixture-call.json"
    outcome_file.unlink(missing_ok=True)
    result = api(
        "POST",
        f"/api/session/{session_id}/command",
        {
            "name": "fixture-call",
            "text": json.dumps({"tool": tool, "delay_ms": delay_ms}),
        },
    )
    assert result is None or "httpError" not in result, result
    assert outcome_file.exists(), "Fixture command did not record its result"
    return cast(CallOutcome, json.loads(outcome_file.read_text()))


def check_execution_timeout(session_id: str, tool: str, progress_path: Path) -> None:
    outcome = call_fixture(session_id, tool, 100)
    assert outcome["error"] is None, outcome
    previous_progress = len(progress_path.read_text().splitlines())
    outcome = call_fixture(session_id, tool, 4000)
    assert outcome["error"] is not None, outcome
    assert "timed out" in outcome["error"].lower(), outcome
    assert 800 <= outcome["elapsed_ms"] < 3000, outcome
    progress_count = len(progress_path.read_text().splitlines()) - previous_progress
    assert progress_count >= 3, "Fixture did not send progress during the slow call"


def stop_server() -> None:
    selector.close()
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    process.wait(timeout=10)
    assert process.stdout is not None
    print(process.stdout.read()[-4000:], flush=True)


def mcp_status(name: str) -> str:
    query = urlencode({"location[directory]": str(project / "nested")})
    result = api("GET", "/api/mcp?" + query)
    assert result is not None and "httpError" not in result, result
    servers = cast(list[dict[str, object]], result["data"])
    for server in servers:
        if server["name"] == name:
            return cast(dict[str, str], server["status"])["status"]
    raise AssertionError(f"Missing MCP server: {name}")


try:
    session_id = session("Harmless MCP approval test")
    assert start_count() == 0, "Fixture started merely by opening the project"
    print("PASS: opening the project does not start the fixture", flush=True)

    prompt = prompt_for(
        session_id, "Fixture approval test; no model request is needed."
    )
    request = wait_for(form, "First prompt did not create a native approval form")
    location_query = urlencode({"location[directory]": str(project / "nested")})
    loaded_plugins = api("GET", "/api/plugin?" + location_query)
    assert loaded_plugins is not None and "httpError" not in loaded_plugins, (
        loaded_plugins
    )
    plugins = cast(list[dict[str, object]], loaded_plugins["data"])
    assert sum(plugin.get("id") == "mcp-json" for plugin in plugins) == 1, plugins
    print("PASS: installed package loads exactly one importer", flush=True)
    assert request.get("metadata", {}).get("kind") == "question", (
        "Form is invisible to the Web question dock"
    )
    field = request["fields"][0]
    assert field["default"] == "reject"
    assert field["custom"] is False
    description = field["description"]
    assert str(project) in description and "fixture.py" in description
    assert 'Server: "fixture"' in description
    option_values = {option["value"] for option in field["options"]}
    assert option_values == {"reject", "trust"}
    assert start_count() == 0, "Fixture started before approval"
    print(
        "PASS: native form shows project/command, defaults to Reject, and blocks startup",
        flush=True,
    )
    reply(request, "reject")
    prompt.result(timeout=10)
    assert start_count() == 0, "Rejected server started"
    print("PASS: rejection prevents startup", flush=True)

    api(
        "POST",
        f"/api/session/{session_id}/prompt",
        {"text": "Rejected definitions should not nag on every prompt."},
    )
    assert form() is None and start_count() == 0
    print("PASS: rejection is remembered; explicit review permits retry", flush=True)

    prompt = review_for(session_id)
    request = wait_for(form, "Retry did not show an approval form")
    result = api("DELETE", f"/api/session/{request['sessionID']}/form/{request['id']}")
    assert result is None or "httpError" not in result, result
    prompt.result(timeout=10)
    assert start_count() == 0, "Dismissed form started a server"
    print("PASS: dismissal prevents startup", flush=True)

    prompt = review_for(session_id)
    request = wait_for(form, "Retry did not ask for approval")
    reply(request, "trust")
    wait_for(lambda: start_count() == 1, "Approved fixture did not start")
    prompt.result(timeout=10)
    print("PASS: approval starts the fixture", flush=True)

    assert launch_context.exists(), "Fixture did not capture its launch context"
    received = cast(LaunchContext, json.loads(launch_context.read_text()))
    assert received == {
        "executable": sys.executable,
        "args": [
            "process-value",
            "{env:FIXTURE_NATIVE_VALUE}",
            "{file:fixture-secret.txt}",
        ],
        "cwd": str(project / "bridge"),
        "environment": {
            "CLAUDE_PROJECT_DIR": str(project),
            "FIXTURE_VALUE": "process-value",
            "FIXTURE_LITERAL": "{env:FIXTURE_NATIVE_VALUE}",
            "FIXTURE_FILE": "{file:fixture-secret.txt}",
        },
    }, received
    print(
        "PASS: real launch values match conversion; native env/file tokens stay literal",
        flush=True,
    )
    assert "OpenCode execution timeout: 1000 ms" in request["fields"][0]["description"]
    check_execution_timeout(session_id, "fixture_probe", progress_file)
    print(
        "PASS: local execution timeout holds despite progress notifications", flush=True
    )

    api(
        "POST",
        f"/api/session/{session_id}/prompt",
        {"text": "Same approved definition."},
    )
    assert form() is None, "Approved definition asked again"
    assert start_count() == 1, "Approved definition restarted unnecessarily"
    print("PASS: unchanged definition remembers project approval", flush=True)

    change_definition("changed-definition")
    prompt = prompt_for(session_id, "Changed fixture definition.")
    request = wait_for(form, "Changed definition reused an earlier approval")
    assert start_count() == 1, "Changed definition started without approval"
    reply(request, "reject")
    prompt.result(timeout=10)
    print(
        "PASS: changed definition asks again and stays stopped after rejection",
        flush=True,
    )

    first = session("Concurrent session one")
    second = session("Concurrent session two")
    change_definition("concurrent-definition")
    prompts = [
        prompt_for(first, "Concurrent review one."),
        prompt_for(second, "Concurrent review two."),
    ]
    request = wait_for(form, "Concurrent sessions did not ask for approval")
    time.sleep(0.5)
    assert len(forms()) == 1, "Concurrent sessions created duplicate approval forms"
    assert start_count() == 1, "Concurrent request started a server before approval"
    reply(request, "trust")
    for pending in prompts:
        pending.result(timeout=10)
    wait_for(lambda: start_count() == 2, "Concurrent approval did not start the server")
    assert form() is None
    print(
        "PASS: concurrent sessions share one form and start the server once", flush=True
    )

    change_definition("stale-form")
    prompt = prompt_for(session_id, "Open a form that will become stale.")
    request = wait_for(form, "Stale-form test did not ask for approval")
    change_definition("changed-while-reviewing")
    reply(request, "trust")
    prompt.result(timeout=10)
    assert start_count() == 2, "A stale form approved a different definition"
    prompt = prompt_for(session_id, "Review the actual current definition.")
    request = wait_for(form, "Changed-while-reviewing definition did not ask again")
    reply(request, "trust")
    wait_for(
        lambda: start_count() == 3,
        "Fresh approval did not start the current definition",
    )
    prompt.result(timeout=10)
    print(
        "PASS: changing a definition while its form is open invalidates that approval",
        flush=True,
    )

    allowed_session = session(
        "Explicit allow bypass test",
        [{"action": "*", "resource": "*", "effect": "allow"}],
    )
    change_definition("explicit-allow-rule")
    prompt = prompt_for(allowed_session, "Test broad allow without inference.")
    request = wait_for(form, "Broad tool allow bypassed the approval form")
    assert start_count() == 3
    reply(request, "reject")
    prompt.result(timeout=10)
    assert start_count() == 3
    print(
        "PASS: broad tool permission allow does not bypass native form approval",
        flush=True,
    )
    assert not (project / "shadowed.txt").exists(), (
        "Native MCP definition was overwritten"
    )
    assert form() is None, "Disabled/legacy/shadowed entries generated an approval form"
    print(
        "PASS: packaged loading, nested sessions, native precedence, disabled entries and legacy SSE",
        flush=True,
    )

    bridge_failure.touch()
    change_definition("bridge-unavailable")
    api(
        "POST",
        f"/api/session/{session_id}/prompt",
        {"text": "No bridge must mean no startup."},
    )
    assert start_count() == 3 and form() is None
    bridge_failure.unlink()
    print("PASS: service bridge failure leaves imports stopped", flush=True)

    prompt = prompt_for(session_id, "Retry after restoring the bridge.")
    request = wait_for(form, "Recoverable bridge failure suppressed future review")
    result = api(
        "POST",
        f"/api/session/{request['sessionID']}/form/{request['id']}/reply",
        {"answer": {"decision": "please start it"}},
    )
    if result is not None and "httpError" in result:
        assert result["httpError"] == 400, result
        api("DELETE", f"/api/session/{request['sessionID']}/form/{request['id']}")
    prompt.result(timeout=10)
    assert start_count() == 3
    print("PASS: arbitrary custom form answers cannot approve startup", flush=True)

    project_config.write_text('{"mcpServers":')
    api(
        "POST",
        f"/api/session/{session_id}/prompt",
        {"text": "Malformed configuration must leave imports stopped."},
    )
    assert start_count() == 3 and form() is None
    print(
        "PASS: malformed configuration fails closed without prompting or launching",
        flush=True,
    )

    for project_directory in ["/explicit-root", ""]:
        fixture_definition = definition["mcpServers"]["fixture"]
        fixture_definition["env"]["CLAUDE_PROJECT_DIR"] = project_directory
        project_config.write_text(json.dumps(definition))
        previous_starts = start_count()
        prompt = prompt_for(
            session_id, "Verify explicit project-directory environment."
        )
        request = wait_for(
            form, "Changed project-directory environment did not require review"
        )
        reply(request, "trust")
        wait_for(
            lambda: start_count() > previous_starts,
            "Explicit project-directory environment did not start",
        )
        prompt.result(timeout=10)
        received = cast(LaunchContext, json.loads(launch_context.read_text()))
        assert received["environment"]["CLAUDE_PROJECT_DIR"] == project_directory
    print(
        "PASS: real local environments honor explicit and empty project-directory values",
        flush=True,
    )

    http_capture = root / "http-requests.jsonl"
    http_port = Path(str(http_capture) + ".port")
    http_process = subprocess.Popen(
        [sys.executable, str(fixture_script), "--http", str(http_capture)],
        env=env,
        cwd=project,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    wait_for(http_port.exists, "HTTP fixture did not bind its listener")
    fixture_port = int(http_port.read_text())
    definition["mcpServers"]["fixture"]["disabled"] = True
    definition["mcpServers"]["fixture-http"] = {
        "type": "http",
        "url": f"http://127.0.0.1:{fixture_port}/mcp?literal={{env:FIXTURE_NATIVE_VALUE}}&file={{file:fixture-secret.txt}}",
        "headers": {
            "X-Expanded": "${FIXTURE_PROCESS_VALUE}",
            "X-Literal-Env": "{env:FIXTURE_NATIVE_VALUE}",
            "X-Literal-File": "{file:fixture-secret.txt}",
        },
        "timeout": 1000,
    }
    project_config.write_text(json.dumps(definition))
    prompt = prompt_for(session_id, "Verify HTTP conversion without model inference.")
    request = wait_for(form, "HTTP fixture did not require approval")
    assert request["fields"][0]["description"].find('Server: "fixture-http"') >= 0
    assert not http_capture.exists(), (
        "HTTP fixture received a connection before approval"
    )
    reply(request, "trust")
    prompt.result(timeout=10)
    wait_for(http_capture.exists, "Approved HTTP fixture did not receive a connection")
    requests = [
        cast(HttpRequest, json.loads(line))
        for line in http_capture.read_text().splitlines()
    ]
    received_headers = {
        key.lower(): value for key, value in requests[0]["headers"].items()
    }
    assert received_headers["x-expanded"] == "process-value"
    assert received_headers["x-literal-env"] == "{env:FIXTURE_NATIVE_VALUE}"
    assert received_headers["x-literal-file"] == "{file:fixture-secret.txt}"
    query = parse_qs(urlsplit(requests[0]["path"]).query)
    assert query["literal"] == ["{env:FIXTURE_NATIVE_VALUE}"]
    assert query["file"] == ["{file:fixture-secret.txt}"]
    print("PASS: real HTTP URL and headers preserve the converted values", flush=True)
    check_execution_timeout(
        session_id, "fixture-http_probe", Path(str(http_capture) + ".progress")
    )
    print(
        "PASS: HTTP execution timeout holds despite progress notifications", flush=True
    )

    approved_marker = project / "approved.txt"
    rejected_marker = project / "rejected.txt"
    remembered: ProjectDefinition = {
        "mcpServers": {
            name: {
                "command": sys.executable,
                "args": [str(fixture_script), str(target)],
                "cwd": str(project),
                "env": {"CLAUDE_PROJECT_DIR": str(project)},
            }
            for name, target in [
                ("approved", approved_marker),
                ("rejected", rejected_marker),
            ]
        }
    }
    project_config.write_text(json.dumps(remembered))
    prompt = prompt_for(session_id, "Remember two decisions for restart testing.")
    request = wait_for(form, "Approval persistence test did not show a form")
    assert 'Server: "approved"' in request["fields"][0]["description"]
    reply(request, "trust")
    request = wait_for(form, "Rejection persistence test did not show a form")
    assert 'Server: "rejected"' in request["fields"][0]["description"]
    reply(request, "reject")
    prompt.result(timeout=10)
    assert approved_marker.exists() and not rejected_marker.exists()
    starts_before_restart = len(approved_marker.read_text().splitlines())
    stop_server()
    process, selector, url = start_server()
    resumed = session("Packaged persistence after restart")
    api(
        "POST", f"/api/session/{resumed}/prompt", {"text": "Reuse persisted decisions."}
    )
    wait_for(
        lambda: len(approved_marker.read_text().splitlines()) > starts_before_restart,
        "Approval did not survive restart",
    )
    assert form() is None and not rejected_marker.exists()
    assert mcp_status("approved") == "connected"
    assert mcp_status("rejected") == "disabled"
    print(
        "PASS: package approval and rejection persist across server restart", flush=True
    )

    other_project = root / "other-project"
    other_project.mkdir()
    subprocess.run(["git", "init", "-q", str(other_project)], check=True)
    (other_project / ".mcp.json").write_text(json.dumps(remembered))
    other_session = session(
        "Identical definitions in another project", directory=other_project
    )
    approved_starts = len(approved_marker.read_text().splitlines())
    prompt = prompt_for(other_session, "Project decisions must not leak.")
    for name in ["approved", "rejected"]:
        request = wait_for(form, f"Other project reused the {name} decision")
        assert "Server: " + json.dumps(name) in request["fields"][0]["description"]
        reply(request, "reject")
    prompt.result(timeout=10)
    assert len(approved_marker.read_text().splitlines()) == approved_starts
    assert not rejected_marker.exists()
    print(
        "PASS: identical effective definitions do not share decisions between projects",
        flush=True,
    )

    prompt = review_for(resumed)
    request = wait_for(form, "Manual review did not revisit persisted approval")
    assert 'Server: "approved"' in request["fields"][0]["description"]
    assert mcp_status("approved") == "disabled", (
        "Approval was not revoked before review"
    )
    reply(request, "reject")
    request = wait_for(form, "Manual review did not revisit persisted rejection")
    reply(request, "reject")
    prompt.result(timeout=10)
    stop_server()
    process, selector, url = start_server()
    resumed = session("Revocation after another restart")
    api(
        "POST",
        f"/api/session/{resumed}/prompt",
        {"text": "Revoked approval must stay revoked."},
    )
    assert form() is None and mcp_status("approved") == "disabled"
    assert len(approved_marker.read_text().splitlines()) == approved_starts
    print(
        "PASS: manual revocation disables before review and persists across restart",
        flush=True,
    )

    remembered["mcpServers"]["approved"]["args"].append("new-definition")
    project_config.write_text(json.dumps(remembered))
    prompt = prompt_for(
        resumed, "Changed definitions still require approval after restart."
    )
    request = wait_for(form, "Changed definition inherited a persisted decision")
    assert mcp_status("approved") == "disabled"
    reply(request, "trust")
    prompt.result(timeout=10)
    wait_for(
        lambda: len(approved_marker.read_text().splitlines()) > approved_starts,
        "Fresh approval did not start the changed definition",
    )
    print(
        "PASS: definition changes invalidate persisted decisions after restart",
        flush=True,
    )
    print(
        "RESULT: production adapter integration passed without real project servers or inference",
        flush=True,
    )
finally:
    stop_server()
    pool.shutdown(wait=True, cancel_futures=True)
    if http_process is not None:
        if http_process.poll() is None:
            os.killpg(http_process.pid, signal.SIGTERM)
        http_process.wait(timeout=10)
        assert http_process.stderr is not None
        print(http_process.stderr.read()[-4000:], flush=True)
    print("Isolated fixture artifacts:", root, flush=True)

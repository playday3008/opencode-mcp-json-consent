import json
import os
import sys
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NotRequired, TypedDict, cast


class Arguments(TypedDict, total=False):
    delay_ms: int


class Metadata(TypedDict, total=False):
    progressToken: str | int


class Parameters(TypedDict, total=False):
    arguments: Arguments
    _meta: Metadata


class Message(TypedDict):
    id: str | int
    method: str
    params: NotRequired[Parameters]


def responses(message: Message, progress_file: Path) -> Iterator[dict[str, object]]:
    method = message["method"]
    result: dict[str, object]
    if method == "initialize":
        result = {
            "protocolVersion": "2025-03-26",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "harmless-approval-fixture", "version": "1.0"},
        }
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "probe",
                    "description": "Harmless delayed fixture response",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"delay_ms": {"type": "integer", "minimum": 0}},
                    },
                }
            ]
        }
    elif method == "tools/call":
        params: Parameters = message.get("params", {})
        delay_ms = params.get("arguments", {}).get("delay_ms", 0)
        token = params.get("_meta", {}).get("progressToken")
        started = time.monotonic()
        deadline = started + delay_ms / 1000
        while time.monotonic() < deadline:
            if token is not None:
                with progress_file.open("a") as progress:
                    progress.write("progress\n")
                yield {
                    "jsonrpc": "2.0",
                    "method": "notifications/progress",
                    "params": {
                        "progressToken": token,
                        "progress": (time.monotonic() - started) * 1000,
                        "total": delay_ms,
                    },
                }
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        result = {"content": [{"type": "text", "text": "fixture-complete"}]}
    else:
        result = {}

    yield {"jsonrpc": "2.0", "id": message["id"], "result": result}


if sys.argv[1] == "--http":
    capture_file = Path(sys.argv[2])
    progress_file = Path(str(capture_file) + ".progress")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            self.send_error(405)

        def do_POST(self) -> None:
            with capture_file.open("a") as capture:
                capture.write(
                    json.dumps({"path": self.path, "headers": dict(self.headers)})
                    + "\n"
                )
            length = int(self.headers.get("Content-Length", "0"))
            message = cast(Message, json.loads(self.rfile.read(length)))
            if "id" not in message:
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            if message["method"] == "tools/call":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    for response in responses(message, progress_file):
                        event = "event: message\ndata: " + json.dumps(response) + "\n\n"
                        self.wfile.write(event.encode())
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return

            response = next(responses(message, progress_file))
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Path(str(capture_file) + ".port").write_text(str(server.server_port))
    server.serve_forever()
else:
    marker_file = Path(sys.argv[1])
    progress_file = Path(str(marker_file) + ".progress")
    context = {
        "executable": sys.executable,
        "args": sys.argv[2:],
        "cwd": os.getcwd(),
        "environment": {
            key: os.environ.get(key)
            for key in [
                "CLAUDE_PROJECT_DIR",
                "FIXTURE_VALUE",
                "FIXTURE_LITERAL",
                "FIXTURE_FILE",
            ]
        },
    }
    Path(str(marker_file) + ".context.json").write_text(json.dumps(context))
    with marker_file.open("a") as marker:
        marker.write("started\n")

    for line in sys.stdin:
        message = cast(Message, json.loads(line))
        if "id" not in message:
            continue
        for response in responses(message, progress_file):
            print(json.dumps(response), flush=True)

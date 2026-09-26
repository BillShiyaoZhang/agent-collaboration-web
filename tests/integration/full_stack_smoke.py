"""Built Next Web + real Go Registry/MQ/helper + Python RemoteBridge; local identities only."""
import argparse
from datetime import datetime, timedelta, timezone
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

WEB = Path(__file__).resolve().parents[2]
ROOT = WEB.parent
SDK = ROOT / "agent-comm-platform" / "agent-comm"
sys.path[:0] = [str(SDK / "python"), str(SDK / "tools")]
from agent_comm_runtime.remote import RemoteBridge
from agent_comm_runtime.store import Store
from agent_comm_runtime.transport import HelperTransport
from test_helper_platform import port, request, until


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--platform", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    args = parser.parse_args()
    folder = WEB / "build" / "full-stack-smoke" / str(uuid.uuid4())
    folder.mkdir(parents=True)
    ports = {name: port() for name in ("platform", "agent", "web")}
    urls = {name: f"http://127.0.0.1:{value}" for name, value in ports.items()}
    database = folder / "web.db"
    with sqlite3.connect(database) as db:
        db.executescript((WEB / "prisma" / "remote-console.sql").read_text(encoding="utf-8-sig"))
    config = folder / "config.yaml"
    base = folder.as_posix()
    config.write_text(f"""platform:
  data_dir: '{base}/data'
identity:
  keys_dir: '{base}/data/keys'
libp2p:
  listen_addrs: ['/ip4/127.0.0.1/tcp/0']
relay:
  enabled: false
registry:
  persist_db: '{base}/data/registry.db'
mq:
  db_path: '{base}/data/mq.db'
api:
  listen_addr: '127.0.0.1:{ports['platform']}'
  rate_limit_rate: 0
""", encoding="utf-8")
    processes, logs = [], []
    bridge = store = None
    environment = dict(os.environ, DATABASE_URL="file:" + database.as_posix(), NEXTAUTH_URL=urls["web"],
                       NEXTAUTH_SECRET=secrets.token_hex(32), AGENT_PLATFORM_URL=urls["platform"], NEXT_TELEMETRY_DISABLED="1",
                       WORKSPACE_SYNC_DISABLED="1")
    environment["PATH"] = str(args.node.resolve().parent) + os.pathsep + environment.get("PATH", "")

    def start(name, command, cwd=None):
        log = (folder / f"{name}.log").open("ab")
        logs.append(log)
        process = subprocess.Popen(command, cwd=cwd, env=environment, stdout=log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        processes.append(process)

    browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def web(path, data=None, form=False):
        headers = {"Origin": urls["web"]}
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
            data = (urllib.parse.urlencode(data) if form else json.dumps(data)).encode()
        req = urllib.request.Request(urls["web"] + path, data=data, headers=headers)
        with browser.open(req, timeout=20) as result:
            return json.loads(result.read())

    def iso(seconds):
        return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")

    try:
        start("platform", [str(args.platform.resolve()), "-config", str(config)])
        until(lambda: request(urls["platform"], "/healthz"), "platform", timeout=35)
        start("agent", [str(args.helper.resolve()), "daemon", str(folder / "agent-keys"), urls["platform"], str(ports["agent"])])
        agent = until(lambda: request(urls["agent"], "/info"), "agent helper", timeout=35)
        until(lambda: request(urls["platform"], "/api/v1/registry/resolve?urn=" + agent["urn"]).get("found"), "agent registry")
        start("web", [str(args.node.resolve()), str(WEB / "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", str(ports["web"])], cwd=WEB)
        until(lambda: web("/api/auth/csrf"), "built Next Web", timeout=35)
        email, password = "local-smoke@example.invalid", "长" * 24 + secrets.token_urlsafe(24)
        # This test covers Web/Platform behavior, so seed a synthetic verified account in its isolated database.
        subprocess.run([str(args.node.resolve()), str(WEB / "tests/integration/seed-account.cjs"),
                        "--email", email, "--password", password, "--database", str(database.resolve())],
                       cwd=WEB, env=environment, check=True, capture_output=True, text=True,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        with sqlite3.connect(database) as db:
            assert db.execute("SELECT passwordHash FROM User WHERE email = ?", (email,)).fetchone()[0].startswith("$scrypt$v1$")
        csrf = web("/api/auth/csrf")["csrfToken"]
        try:
            web("/api/auth/callback/credentials", {"email": email, "password": "长" * 24 + "wrong-suffix", "csrfToken": csrf, "json": "true", "callbackUrl": urls["web"] + "/dashboard/agents"}, form=True)
        except urllib.error.HTTPError as error:
            assert error.code == 401, error
            rejected = json.loads(error.read())
        else:
            raise AssertionError("wrong password suffix must be rejected")
        assert "CredentialsSignin" in rejected.get("url", ""), rejected
        assert not web("/api/auth/session").get("user"), "wrong password suffix must not establish a session"
        web("/api/auth/callback/credentials", {"email": email, "password": password, "csrfToken": csrf, "json": "true", "callbackUrl": urls["web"] + "/dashboard/agents"}, form=True)
        assert web("/api/auth/session")["user"]["email"] == email
        connection = web("/api/agents", {"name": "Local integration agent", "urn": agent["urn"]})
        identity = web(f"/api/agents/{connection['id']}/bind-owner", {})
        assert identity["virtualUrn"].startswith("urn:hermes:agent:")
        until(lambda: request(urls["platform"], "/api/v1/registry/resolve?urn=" + identity["virtualUrn"]).get("found"), "console registry")
        store = Store(folder / "collaboration.sqlite3", local_urn=agent["urn"])
        owner = "local-smoke-owner|native-session"
        prepared = store.prepare_contact("owner-console", ["仅在 agent 本地保存的联系人"], identity["virtualUrn"], owner)
        confirmation = store.begin_confirmation(prepared["approval_id"], owner)
        store.finish_confirmation(prepared["approval_id"], confirmation["token"], owner, "同意")
        bridge = RemoteBridge(folder / "remote.sqlite3", store, agent["urn"])
        bridge.pair(identity["virtualUrn"], "local-smoke-owner", ["capabilities", "contacts.list"], iso(3600))
        transport = HelperTransport(urls["agent"])

        def roundtrip(method, params=None):
            rid = str(uuid.uuid4())
            path = f"/api/agents/{connection['id']}/control"
            queued = web(path, {"request_id": rid, "method": method, "params": params or {}})
            assert queued["status"] == "pending", queued
            message = until(lambda: next((item for item in transport.retrieve() if item["message_id"] == rid), None), "Web encrypted request arrival", timeout=35)
            assert message["sender_urn"] == identity["virtualUrn"]
            bridge.process(message, transport)

            def completed():
                result = web(path + "?request_id=" + rid)
                return result if result["status"] == "complete" else None

            completed_response = until(completed, "Web verifies agent response", timeout=35)
            response = completed_response["response"]
            assert response["agent_urn"] == agent["urn"] and response["console_urn"] == identity["virtualUrn"]
            return response

        capabilities = roundtrip("capabilities")
        assert any(method["name"] == "contacts.list" and method["available"] for method in capabilities["result"]["methods"])
        contacts = roundtrip("contacts.list")
        assert contacts["result"]["contacts"][0]["aliases"] == ["仅在 agent 本地保存的联系人"]
        friend = {"contact_id": "web-friend", "aliases": ["网页添加的朋友"], "urn": "urn:agent-comm:agent:web-friend"}
        assert roundtrip("contacts.add", friend)["error"]["code"] == "method_not_allowed"
        bridge.pair(identity["virtualUrn"], "local-smoke-owner",
                    ["capabilities", "contacts.list", "collaboration.state", "contacts.add", "approval.respond"], iso(3600))
        assert roundtrip("contacts.add", friend)["result"]["status"] == "requested"
        assert roundtrip("contacts.add", friend)["result"]["status"] == "already_requested"
        decisions = []
        for decision in ("approve", "deny"):
            staged = store.prepare_contact("pending-" + decision, ["网页" + decision], "urn:agent-comm:agent:" + decision, owner)
            state = roundtrip("collaboration.state")["result"]
            assert any(item["approval_id"] == staged["approval_id"] and item["question"] for item in state["pending_confirmations"])
            result = roundtrip("approval.respond", {"approval_id": staged["approval_id"], "decision": decision})["result"]
            assert result["status"] == ("approved_once" if decision == "approve" else "denied")
            decisions.append(staged["approval_id"])
        state = roundtrip("collaboration.state")["result"]
        assert {item["approval_id"] for item in state["approval_decisions"]}.issuperset(decisions)
        assert {item["contact_id"] for item in state["contacts"]} == {"owner-console", "web-friend", "pending-approve"}
        saved = web(f"/api/agents/{connection['id']}/workspace")
        assert saved["snapshots"]["contacts.list"]["data"]["contacts"] == state["contacts"]
        assert saved["snapshots"]["collaboration.state"]["data"]["pending_confirmations"] == []
        bridge.revoke(identity["virtualUrn"])
        assert roundtrip("contacts.list")["error"]["code"] == "not_paired"
        with sqlite3.connect(database) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert not tables.intersection({"Contact", "Message", "HITLRequest", "Transaction"})
            assert db.execute("SELECT COUNT(*) FROM ControlRequest WHERE status='complete'").fetchone()[0] == 11
        report = {"result": "PASS", "checks": ["built Next login/session and full UTF-8 password verification beyond 72 bytes", "real Web console URN accepted by Python pairing",
            "Node signed encrypted request through real Go MQ/helper", "agent-owned contacts returned to Web",
            "new action scopes are explicit and denied for existing read-only pairing",
            "Web directly adds an idempotent contact and approves/denies agent confirmations",
            "agent contacts and completed decisions synchronize into the encrypted Web workspace",
            "Web cryptographic correlation and response persistence", "local pairing revocation returned as error",
            "no independent Web domain tables"], "logs": str(folder), "scope": "Fresh local test account, keys and processes only; no public messages or model calls"}
        (folder / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        if bridge:
            bridge.close()
        if store:
            store.close()
        for process in reversed(processes):
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=8)
        for log in logs:
            log.close()


if __name__ == "__main__":
    main()

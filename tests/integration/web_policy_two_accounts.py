"""Real local Web + Platform policy gates for two synthetic accounts.

The test uses fresh keys, accounts and SQLite databases under ignored build/.
It deliberately does not represent a human's compliance consent.
"""

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
import urllib.error
import urllib.parse
import urllib.request
import uuid

WEB = Path(__file__).resolve().parents[2]
ROOT = WEB.parent
SDK = ROOT / "agent-comm-platform" / "agent-comm"
sys.path[:0] = [str(SDK / "python"), str(SDK / "tools")]
from agent_comm_runtime.remote import RemoteBridge  # noqa: E402
from agent_comm_runtime.store import Store  # noqa: E402
from agent_comm_runtime.transport import HelperTransport  # noqa: E402
from test_helper_platform import port, request, until  # noqa: E402


def cli(binary, *args):
    result = subprocess.run([str(binary), *map(str, args)], check=True,
                            capture_output=True, text=True, timeout=30)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True,
                        help="Current helper, used to initialize Platform identity")
    parser.add_argument("--legacy-helper", type=Path, required=True,
                        help="Published r2 v1 helper, used for actual old-agent roundtrips")
    parser.add_argument("--policy-tool", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    args = parser.parse_args()
    folder = WEB / "build" / "web-policy-two-accounts" / str(uuid.uuid4())
    folder.mkdir(parents=True)
    ports = {name: port() for name in ("platform", "agent", "web")}
    urls = {name: f"http://127.0.0.1:{value}" for name, value in ports.items()}
    database = folder / "web.db"
    with sqlite3.connect(database) as db:
        db.executescript((WEB / "prisma" / "remote-console.sql").read_text(encoding="utf-8-sig"))

    keys = folder / "v2-keys"
    cli(args.policy_tool.resolve(), "keygen", "--out-dir", keys)
    platform_keys = folder / "platform-data" / "keys"
    platform_identity = cli(args.helper.resolve(), "init", platform_keys)
    config = folder / "platform.yaml"
    processes = {}
    logs = []
    store = bridge = None
    env = dict(os.environ, DATABASE_URL="file:" + database.as_posix() + "?connection_limit=1",
               NEXTAUTH_URL=urls["web"], NEXTAUTH_SECRET=secrets.token_hex(32),
               AGENT_PLATFORM_URL=urls["platform"], NEXT_TELEMETRY_DISABLED="1",
               WORKSPACE_SYNC_DISABLED="1",
               AGENT_V2_POLICY_ROOT_PUBLIC_KEY=(keys / "policy-root.public").read_bytes().hex(),
               AGENT_V2_PLATFORM_ID=platform_identity["peer_id"],
               AGENT_MANAGED_ISSUER_PRIVATE_KEY_FILE=str(keys / "managed-issuer.private"))
    env["PATH"] = str(args.node.resolve().parent) + os.pathsep + env.get("PATH", "")

    def configure(mode, epoch, allow_v1=False):
        policy_file = folder / f"policy-{epoch}.json"
        command = ["sign", "--keys-dir", keys, "--platform-id", platform_identity["peer_id"],
                   "--mode", mode, "--epoch", epoch, "--out", policy_file]
        if allow_v1:
            command.append("--allow-v1")
        cli(args.policy_tool.resolve(), *command)
        base = folder.as_posix()
        config.write_text(f"""platform:
  data_dir: '{base}/platform-data'
identity:
  keys_dir: '{platform_keys.as_posix()}'
libp2p:
  listen_addrs: ['/ip4/127.0.0.1/tcp/0']
relay:
  enabled: false
registry:
  persist_db: '{base}/platform-data/registry.db'
mq:
  db_path: '{base}/platform-data/mq.db'
v2:
  enabled: true
  policy_file: '{policy_file.as_posix()}'
  policy_root_public_key_file: '{(keys / 'policy-root.public').as_posix()}'
  gateway_private_key_file: '{(keys / 'gateway.private').as_posix()}'
  receipt_private_key_file: '{(keys / 'receipt.private').as_posix()}'
api:
  listen_addr: '127.0.0.1:{ports['platform']}'
  rate_limit_rate: 0
""", encoding="utf-8")

    def start(name, command, cwd=None):
        log = (folder / f"{name}.log").open("ab")
        logs.append(log)
        processes[name] = subprocess.Popen(command, cwd=cwd, env=env, stdout=log,
            stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)

    def stop(name):
        process = processes.pop(name, None)
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=8)

    def start_platform():
        start("platform", [str(args.platform.resolve()), "-config", str(config)])
        until(lambda: request(urls["platform"], "/healthz"), "Platform startup", timeout=40)

    def client():
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                             urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

        def web(path, data=None, form=False, method=None):
            headers = {"Origin": urls["web"]}
            if data is not None:
                headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
                data = (urllib.parse.urlencode(data) if form else json.dumps(data)).encode()
            req = urllib.request.Request(urls["web"] + path, data=data, headers=headers, method=method)
            try:
                with opener.open(req, timeout=20) as response:
                    content = response.read()
                    return response.status, json.loads(content) if content else None
            except urllib.error.HTTPError as error:
                content = error.read()
                return error.code, json.loads(content) if content else None

        return web

    def ok(web, path, data=None, form=False, method=None, status=200):
        code, body = web(path, data, form, method)
        assert code == status, (path, code, body)
        return body

    def control(web, agent_id, expected=202):
        rid = str(uuid.uuid4())
        path = f"/api/agents/{agent_id}/control"
        code, body = web(path, {"request_id": rid, "method": "contacts.list", "params": {}})
        assert code == expected, (path, code, body)
        return rid, body

    def disclosure(web, mode, epoch, confirmed, paused, enabled):
        body = ok(web, "/api/platform-policy")
        assert body["status"] == "signed" and body["mode"] == mode and body["epoch"] == epoch, body
        assert body["confirmed"] is confirmed and body["paused"] is paused, body
        assert body["can_use_workbench"] is enabled, body
        assert body["platform_id"] == platform_identity["peer_id"], body
        return body

    def db_count(table, user_id=None):
        with sqlite3.connect(database) as db:
            if user_id is None:
                return db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            return db.execute(f'SELECT COUNT(*) FROM "{table}" WHERE "userId"=?', (user_id,)).fetchone()[0]

    checks = []
    try:
        configure("private", 1, allow_v1=True)
        start_platform()
        start("agent", [str(args.legacy_helper.resolve()), "daemon", str(folder / "agent-keys"),
                        urls["platform"], str(ports["agent"])])
        agent = until(lambda: request(urls["agent"], "/info"), "legacy agent", timeout=40)
        until(lambda: request(urls["platform"], "/api/v1/registry/resolve?urn=" + agent["urn"]).get("found"),
              "legacy agent registry", timeout=40)
        start("web", [str(args.node.resolve()), str(WEB / "node_modules/next/dist/bin/next"),
                      "start", "--hostname", "127.0.0.1", "--port", str(ports["web"])], cwd=WEB)
        accounts = {}
        for name in ("a", "b"):
            web = client()
            until(lambda: web("/api/auth/csrf")[0] == 200, "Web startup", timeout=40)
            email = f"{name}-{uuid.uuid4().hex}@example.invalid"
            password = secrets.token_urlsafe(36)
            # This test covers Web/Platform behavior, so seed a synthetic verified account in its isolated database.
            subprocess.run([str(args.node.resolve()), str(WEB / "tests/integration/seed-account.cjs"),
                            "--email", email, "--password", password, "--database", str(database.resolve())],
                           cwd=WEB, env=env, check=True, capture_output=True, text=True,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            csrf = ok(web, "/api/auth/csrf")["csrfToken"]
            ok(web, "/api/auth/callback/credentials", {"email": email, "password": password,
                "csrfToken": csrf, "json": "true", "callbackUrl": urls["web"] + "/dashboard/agents"}, form=True)
            session = ok(web, "/api/auth/session")
            assert session["user"]["email"] == email, session
            agent_row = ok(web, "/api/agents", {"name": f"Synthetic agent {name}", "urn": agent["urn"]}, status=201)
            identity = ok(web, f"/api/agents/{agent_row['id']}/bind-owner", {})
            until(lambda: request(urls["platform"], "/api/v1/registry/resolve?urn=" + identity["virtualUrn"]).get("found"),
                  f"console {name} registry", timeout=40)
            accounts[name] = {"web": web, "user_id": session["user"]["id"],
                              "agent_id": agent_row["id"], "urn": identity["virtualUrn"]}
            disclosure(web, "private", 1, False, False, True)
        assert accounts["a"]["urn"] != accounts["b"]["urn"]
        assert accounts["a"]["user_id"] != accounts["b"]["user_id"]
        assert accounts["a"]["web"](f"/api/agents/{accounts['b']['agent_id']}/workspace")[0] == 404
        checks.append("two isolated authenticated Web accounts and console identities under signed private policy")

        store = Store(folder / "agent-collaboration.sqlite3", local_urn=agent["urn"])
        owner = "synthetic-local-owner"
        prepared = store.prepare_contact("seed", ["synthetic saved contact"],
                                         "urn:agent-comm:agent:synthetic-contact", owner)
        confirmation = store.begin_confirmation(prepared["approval_id"], owner)
        store.finish_confirmation(prepared["approval_id"], confirmation["token"], owner, "同意")
        bridge = RemoteBridge(folder / "agent-remote.sqlite3", store, agent["urn"])
        for account in accounts.values():
            bridge.pair(account["urn"], owner, ["capabilities", "contacts.list"],
                        (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z"))
        transport = HelperTransport(urls["agent"])
        for name, account in accounts.items():
            rid, queued = control(account["web"], account["agent_id"])
            assert queued["status"] == "pending", queued
            message = until(lambda: next((item for item in transport.retrieve() if item["message_id"] == rid), None),
                            f"account {name} encrypted request", timeout=40)
            assert message["sender_urn"] == account["urn"]
            bridge.process(message, transport)
            def completed():
                code, body = account["web"](f"/api/agents/{account['agent_id']}/control?request_id={rid}")
                assert code == 200, (code, body)
                return body if body["status"] == "complete" else None
            response = until(completed, f"account {name} authenticated response", timeout=40)
            assert response["response"]["result"]["contacts"][0]["aliases"] == ["synthetic saved contact"]
            assert ok(account["web"], f"/api/agents/{account['agent_id']}/workspace")["snapshots"]["contacts.list"]
        assert db_count("ManagedConsoleCertificate") == 0
        checks.append("real published v1 agent roundtrips and durable per-account snapshots during signed private migration")

        stop("platform")
        configure("private", 2)
        start_platform()
        for account in accounts.values():
            disclosure(account["web"], "private", 2, False, False, True)
        a, b = accounts["a"], accounts["b"]
        control(a["web"], a["agent_id"])
        assert db_count("ManagedConsoleCertificate", a["user_id"]) == 1
        assert db_count("ManagedConsoleCertificate", b["user_id"]) == 0
        checks.append("strict signed private policy enrolls only the active account's managed console")

        stop("platform")
        configure("compliance", 3)
        start_platform()
        old_snapshots = {name: ok(account["web"], f"/api/agents/{account['agent_id']}/workspace")["snapshots"]
                         for name, account in accounts.items()}
        states = {name: disclosure(account["web"], "compliance", 3, False, False, False)
                  for name, account in accounts.items()}
        for account in accounts.values():
            control(account["web"], account["agent_id"], expected=409)
        assert db_count("ControlRequest") == 3
        wrong_hash = "0" * 64 if states["a"]["policy_hash"] != "0" * 64 else "1" * 64
        assert a["web"]("/api/platform-policy", {"policy_hash": wrong_hash, "confirm": True})[0] == 409
        disclosure(a["web"], "compliance", 3, False, False, False)
        confirmed = ok(a["web"], "/api/platform-policy",
                       {"policy_hash": states["a"]["policy_hash"], "confirm": True})
        assert confirmed["confirmed"] and confirmed["can_use_workbench"]
        disclosure(b["web"], "compliance", 3, False, False, False)
        control(a["web"], a["agent_id"])
        control(b["web"], b["agent_id"], expected=409)
        assert db_count("ManagedConsoleCertificate", a["user_id"]) == 1
        assert db_count("ManagedConsoleCertificate", b["user_id"]) == 0
        checks.append("compliance confirmation binds the current API policy hash and gates each account independently")

        assert ok(a["web"], "/api/platform-policy", method="DELETE")["paused"] is True
        disclosure(a["web"], "compliance", 3, True, True, False)
        control(a["web"], a["agent_id"], expected=409)
        assert db_count("ControlRequest") == 4
        resumed = ok(a["web"], "/api/platform-policy", {"resume": True})
        assert resumed["confirmed"] and resumed["can_use_workbench"] and not resumed["paused"]
        control(a["web"], a["agent_id"])
        ok(b["web"], "/api/platform-policy", {"policy_hash": states["b"]["policy_hash"], "confirm": True})
        control(b["web"], b["agent_id"])
        assert db_count("ManagedConsoleCertificate", b["user_id"]) == 1
        checks.append("account-specific pause/resume and second account confirmation restore new controls")

        before_unavailable = db_count("ControlRequest")
        stop("platform")
        for name, account in accounts.items():
            code, _ = account["web"]("/api/platform-policy")
            assert code == 503, (name, code)
            control(account["web"], account["agent_id"], expected=503)
            snapshot = ok(account["web"], f"/api/agents/{account['agent_id']}/workspace")["snapshots"]
            assert snapshot == old_snapshots[name], name
        assert db_count("ControlRequest") == before_unavailable
        checks.append("policy outage rejects fresh control for both accounts while preserving authenticated old snapshots")
        report = {"result": "PASS", "checks": checks, "logs": str(folder),
                  "scope": "Fresh loopback Web/Platform and SQLite only; confirmations are synthetic, not human consent"}
        (folder / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        if bridge:
            bridge.close()
        if store:
            store.close()
        for name in list(processes):
            stop(name)
        for log in logs:
            log.close()


if __name__ == "__main__":
    main()

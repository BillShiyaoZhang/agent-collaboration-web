"""Real local Web + Platform managed-console certificate recovery matrix.

All accounts, keys, and databases are synthetic and isolated under ignored build/.
This test does not represent a human's compliance consent.
"""

import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
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
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization

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
    folder = WEB / "build" / "web-managed-cert-matrix" / str(uuid.uuid4())
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
            ok(web, "/api/auth/register", {"email": email, "password": password}, status=201)
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
        valid_id, _ = control(a["web"], a["agent_id"])
        assert db_count("ManagedConsoleCertificate", a["user_id"]) == 1
        assert db_count("ManagedConsoleCertificate", b["user_id"]) == 0
        def certificate():
            with sqlite3.connect(database) as db:
                row = db.execute('SELECT certificate FROM "ManagedConsoleCertificate" WHERE "userId"=?',
                                 (a["user_id"],)).fetchone()
            return json.loads(base64.b64decode(row[0]))

        def managed_row():
            with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
                return db.execute("SELECT serial,expires_at,revoked FROM v2_managed_identities WHERE urn=?",
                                  (a["urn"],)).fetchone()

        with sqlite3.connect(database) as db:
            key_row = db.execute('SELECT "virtualEd25519PrivateKey","virtualKeySalt","virtualEd25519PublicKey" '
                                 'FROM "User" WHERE id=?', (a["user_id"],)).fetchone()
        protected = json.loads(key_row[0])
        salt = bytes.fromhex(protected.get("salt") or key_row[1])
        wrapping = hashlib.pbkdf2_hmac("sha256", env["NEXTAUTH_SECRET"].encode(), salt, 100000, 32)
        private_der = bytes.fromhex(AESGCM(wrapping).decrypt(bytes.fromhex(protected["iv"]),
            bytes.fromhex(protected["encrypted"]) + bytes.fromhex(protected["authTag"]), None).decode())
        console_private = serialization.load_der_private_key(private_der, password=None)
        assert isinstance(console_private, ed25519.Ed25519PrivateKey)

        def managed_enroll(raw_certificate, signer=console_private, pubkey=key_row[2]):
            body = json.dumps({"certificate": base64.b64encode(raw_certificate).decode()},
                              separators=(",", ":")).encode()
            signature = signer.sign(body).hex()
            request = urllib.request.Request(urls["platform"] + "/api/v2/managed/identity", body,
                {"Content-Type": "application/json", "Authorization": f"Ed25519 {signature}:{pubkey}"})
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    return response.status, response.read().decode()
            except urllib.error.HTTPError as error:
                return error.code, error.read().decode()

        def canonical_certificate(value):
            return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()

        def process_request(request_id):
            message = until(lambda: next((item for item in transport.retrieve()
                                          if item["message_id"] == request_id), None),
                            "strict managed request", timeout=40)
            bridge.process(message, transport)

        def completed(request_id):
            path = f"/api/agents/{a['agent_id']}/control?request_id={request_id}"
            def check():
                code, body = a["web"](path)
                assert code == 200, (code, body)
                return body if body["status"] == "complete" else None
            return until(check, "strict managed response", timeout=40)

        def pending_response_id():
            with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
                row = db.execute("SELECT id FROM messages WHERE recipient=? AND read_at=0 ORDER BY stored_at_ns DESC LIMIT 1",
                                 (a["urn"],)).fetchone()
            return row[0] if row else None

        first_serial = certificate()["serial"]
        assert first_serial == managed_row()[0]
        process_request(valid_id)
        valid_response_id = until(pending_response_id, "queued valid response", timeout=30)
        assert completed(valid_id)["response"]["result"]["contacts"]
        with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
            assert db.execute("SELECT read_at FROM messages WHERE id=?", (valid_response_id,)).fetchone()[0] > 0
        checks.append("valid managed certificate permits real strict-private Web request, v1 response retrieve, and ACK")

        # Exercise Platform's real enrollment endpoint with correctly signed
        # possession proofs. The issuer key and console key are only synthetic.
        valid_certificate = certificate()
        assert managed_enroll(canonical_certificate(valid_certificate))[0] == 200
        assert managed_enroll(b"")[0] == 400
        tampered = dict(valid_certificate, signature=base64.b64encode(secrets.token_bytes(64)).decode())
        assert managed_enroll(canonical_certificate(tampered))[0] == 400
        issuer_seed = (keys / "managed-issuer.private").read_bytes()[:32]
        issuer_private = ed25519.Ed25519PrivateKey.from_private_bytes(issuer_seed)
        def issue(changes):
            cert = dict(valid_certificate, **changes, signature=None)
            preimage = b"agent-comm-v2-managed-console\0" + canonical_certificate(cert)
            cert["signature"] = base64.b64encode(issuer_private.sign(preimage)).decode()
            return canonical_certificate(cert)
        now = int(datetime.now(timezone.utc).timestamp())
        expired_cert = issue({"not_before": now - 120, "expires_at": now - 1,
                              "serial": str(uuid.uuid4())})
        assert managed_enroll(expired_cert)[0] == 400
        wrong_platform_cert = issue({"platform_id": "unrelated-platform-id", "serial": str(uuid.uuid4())})
        assert managed_enroll(wrong_platform_cert)[0] == 400
        other_private = ed25519.Ed25519PrivateKey.generate()
        other_public = other_private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
        assert managed_enroll(canonical_certificate(valid_certificate), other_private, other_public)[0] == 401
        assert managed_row()[0] == first_serial
        checks.append("live managed enrollment rejects missing, tampered, issuer-signed expired/wrong-platform, and wrong possession key")

        # A missing Web cache forces a fresh signed enrollment even though the
        # Platform still retains its old grant.
        with sqlite3.connect(database) as db:
            db.execute('DELETE FROM "ManagedConsoleCertificate" WHERE "userId"=?', (a["user_id"],))
        cache_id, _ = control(a["web"], a["agent_id"])
        assert certificate()["serial"] != first_serial
        process_request(cache_id)
        assert completed(cache_id)["status"] == "complete"
        checks.append("missing Web certificate cache re-enrolls and completes a real control roundtrip")

        # Expiration in the local cache is renewed before a new store.
        before_expiry = certificate()["serial"]
        with sqlite3.connect(database) as db:
            db.execute('UPDATE "ManagedConsoleCertificate" SET "expiresAt"=? WHERE "userId"=?',
                       ("2000-01-01T00:00:00.000Z", a["user_id"]))
        expiry_id, _ = control(a["web"], a["agent_id"])
        assert certificate()["serial"] != before_expiry
        process_request(expiry_id)
        assert completed(expiry_id)["status"] == "complete"
        checks.append("expired cached certificate renews before store and response retrieve")

        # Loss of the Platform grant is repaired only on store's 403 path.
        before_loss = certificate()["serial"]
        with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
            db.execute("DELETE FROM v2_managed_identities WHERE urn=?", (a["urn"],))
        lost_id, _ = control(a["web"], a["agent_id"])
        assert certificate()["serial"] != before_loss
        assert managed_row()[0] == certificate()["serial"]
        with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
            assert db.execute("SELECT COUNT(*) FROM messages WHERE id=?", (lost_id,)).fetchone()[0] == 1
        process_request(lost_id)
        assert completed(lost_id)["status"] == "complete"
        checks.append("missing Platform grant triggers Web store retry with one request ID and one MQ row")

        # A real revocation remains effective for already queued v1 response
        # traffic. New stores can obtain a fresh serial, but old messages are
        # not retroactively admitted after re-enrollment.
        held_id, _ = control(a["web"], a["agent_id"])
        process_request(held_id)
        held_response_id = until(pending_response_id, "queued response before revocation", timeout=30)
        revoked_certificate = certificate()
        revoked = revoked_certificate["serial"]
        with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
            db.execute("INSERT INTO v2_managed_revocations(serial,revoked_at) VALUES(?,?)",
                       (revoked, int(datetime.now(timezone.utc).timestamp())))
            db.execute("UPDATE v2_managed_identities SET revoked=1 WHERE urn=?", (a["urn"],))
        assert managed_enroll(canonical_certificate(revoked_certificate))[0] == 409
        code, pending = a["web"](f"/api/agents/{a['agent_id']}/control?request_id={held_id}")
        assert code == 200 and pending["status"] == "pending", (code, pending)
        recovered_id, _ = control(a["web"], a["agent_id"])
        assert certificate()["serial"] != revoked and managed_row()[2] == 0
        process_request(recovered_id)
        assert completed(recovered_id)["status"] == "complete"
        code, pending = a["web"](f"/api/agents/{a['agent_id']}/control?request_id={held_id}")
        assert code == 200 and pending["status"] == "pending", (code, pending)
        checks.append("revocation hides earlier in-flight response; new store re-enrolls and recovers only new traffic")

        # ACK is a separate authenticated mailbox operation: the old hidden
        # response remains undisclosed, but its owner can still mark it read.
        ack_body = json.dumps({"recipient_urn": a["urn"], "timestamp": now,
                               "message_ids": [held_response_id]}, separators=(",", ":")).encode()
        ack_signature = console_private.sign(ack_body).hex()
        ack_request = urllib.request.Request(urls["platform"] + "/api/v1/mq/ack", ack_body,
            {"Content-Type": "application/json", "Authorization":
             f"Ed25519 {ack_signature}:{key_row[2]}"})
        with urllib.request.urlopen(ack_request, timeout=10) as response:
            ack = json.loads(response.read())
        assert ack["ok"] is True and ack["deleted"] == 0, ack
        with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
            assert db.execute("SELECT read_at FROM messages WHERE id=?", (held_response_id,)).fetchone()[0] == 0
        checks.append("revoked-era hidden v1 response remains unread despite signed recipient-key ACK")

        # Platform-side expiry has the same 403/re-enrollment path as grant loss.
        before_platform_expiry = certificate()["serial"]
        with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
            db.execute("UPDATE v2_managed_identities SET expires_at=? WHERE urn=?",
                       (int(datetime.now(timezone.utc).timestamp()) - 1, a["urn"]))
        fresh_id, _ = control(a["web"], a["agent_id"])
        assert certificate()["serial"] != before_platform_expiry
        process_request(fresh_id)
        assert completed(fresh_id)["status"] == "complete"
        checks.append("expired Platform grant rejects old serial and store recovers with fresh signed enrollment")

        # Identity conflict cannot be fixed by enrolling another certificate
        # for the same URN: Platform explicitly returns 409 and no v1 row.
        with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
            db.execute("UPDATE v2_managed_identities SET identity_pubkey=? WHERE urn=?",
                       (secrets.token_bytes(32), a["urn"]))
        before_conflict = db_count("ControlRequest")
        conflict_id = str(uuid.uuid4())
        code, conflict = a["web"](f"/api/agents/{a['agent_id']}/control",
                                   {"request_id": conflict_id, "method": "contacts.list", "params": {}})
        assert code == 503 and conflict["error"], (code, conflict)
        assert db_count("ControlRequest") == before_conflict + 1
        with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
            assert db.execute("SELECT COUNT(*) FROM messages WHERE id=?", (conflict_id,)).fetchone()[0] == 0
        checks.append("conflicting enrolled identity fails closed; no MQ row written")

        report = {"result": "PASS", "checks": checks, "logs": str(folder),
                  "scope": "Fresh loopback Web/Platform and SQLite with synthetic identities; revoke, expiry, loss, and conflict injected into isolated databases; not E2 HTTPS or human consent"}
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

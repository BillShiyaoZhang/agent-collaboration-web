"""Bounded local E1 concurrency with real Platform, Web and two old helpers.

All identities, databases and logs are freshly created under ignored build/.
This is HTTP loopback and cannot establish HTTPS/nginx/container stability.
"""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import hashlib
import http.cookiejar
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

WEB = Path(__file__).resolve().parents[2]
ROOT = WEB.parent
SDK = ROOT / "agent-comm-platform" / "agent-comm"
sys.path[:0] = [str(SDK / "python"), str(SDK / "tools")]
from agent_comm_runtime.remote import READ_METHODS, RemoteBridge  # noqa: E402
from agent_comm_runtime.store import Store  # noqa: E402
from agent_comm_runtime.transport import HelperTransport  # noqa: E402
from test_helper_platform import port, request, until  # noqa: E402


def percentile(values, fraction):
    values = sorted(values)
    return round(values[max(0, math.ceil(len(values) * fraction) - 1)], 3) if values else None


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True,
                        help="Published r2 helper with v1 remote control")
    parser.add_argument("--node", type=Path, required=True)
    args = parser.parse_args()
    folder = WEB / "build" / "web-two-agent-stability" / str(uuid.uuid4())
    folder.mkdir(parents=True)
    rounds, parallel = 8, 12
    config = {
        "case": "T21/T08 local E1 subset; not full HTTPS or deployed acceptance",
        "environment": "E1 localhost HTTP; production-mode Next, real Go Platform and two published r2 helpers",
        "build_identity": {"platform_sha256": sha256(args.platform), "helper_sha256": sha256(args.helper),
                           "next_build_id": (WEB / ".next" / "BUILD_ID").read_text(encoding="utf-8").strip()},
        "database_url_shape": "file:<fresh-web.db>?connection_limit=1",
        "accounts": 2, "agents": 2, "rounds_per_account": rounds,
        "max_parallel_http": parallel, "planned_non_injection_http_minimum": 208,
        "per_request_timeout_seconds": 20, "roundtrip_deadline_seconds": 40,
        "normal_window_expected": {"http_5xx": 0, "P2024": 0, "SQLite_Code_5": 0,
                                   "lost_or_duplicate_business": 0, "max_http_seconds": 20},
        "historical_reference_not_pass_threshold": {
            "2026-09-23 local simulated control_GET_p95_seconds": 1.281,
            "2026-09-23 local simulated control_GET_p99_seconds": 1.359,
            "2026-09-23 real cloud two_agent_all_p95_seconds": 0.813},
        "fault": "One planned local Platform stop/restart after enqueue; retry same request ID",
        "limitations": ["No HTTPS/TLS/nginx/container", "No human Hermes model", "Push settings only; no external push delivery"],
    }
    (folder / "run-config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    ports = {name: port() for name in ("platform", "web", "a", "b")}
    urls = {name: f"http://127.0.0.1:{number}" for name, number in ports.items()}
    database = folder / "web.db"
    with sqlite3.connect(database) as db:
        db.executescript((WEB / "prisma" / "remote-console.sql").read_text(encoding="utf-8-sig"))
    base = folder.as_posix()
    platform_config = folder / "platform.yaml"
    platform_config.write_text(f"""platform:
  data_dir: '{base}/platform-data'
identity:
  keys_dir: '{base}/platform-data/keys'
libp2p:
  listen_addrs: ['/ip4/127.0.0.1/tcp/0']
relay:
  enabled: false
registry:
  persist_db: '{base}/platform-data/registry.db'
mq:
  db_path: '{base}/platform-data/mq.db'
api:
  listen_addr: '127.0.0.1:{ports['platform']}'
  rate_limit_rate: 0
""", encoding="utf-8")
    env = dict(os.environ, DATABASE_URL="file:" + database.as_posix() + "?connection_limit=1",
               NEXTAUTH_URL=urls["web"], NEXTAUTH_SECRET=secrets.token_hex(32),
               AGENT_PLATFORM_URL=urls["platform"], NEXT_TELEMETRY_DISABLED="1")
    env.pop("WORKSPACE_SYNC_DISABLED", None)
    env["PATH"] = str(args.node.resolve().parent) + os.pathsep + env.get("PATH", "")
    processes, logs = {}, []
    stores, bridges = {}, {}
    stop_workers = threading.Event()
    pause_a = threading.Event()
    workers = []
    worker_errors = []
    processed = {"a": set(), "b": set()}
    timeline = []

    def start(name, command, cwd=None):
        log = (folder / f"{name}.log").open("ab")
        logs.append(log)
        processes[name] = subprocess.Popen(command, cwd=cwd, env=env, stdout=log,
            stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)

    def stop(name):
        process = processes.pop(name, None)
        if process:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=8)

    def start_platform():
        start("platform", [str(args.platform.resolve()), "-config", str(platform_config)])
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

    def expect(web, path, status=200, data=None, form=False, method=None):
        code, body = web(path, data, form, method)
        assert code == status, (path, code, body)
        return body

    def timed(phase, account, op, web, path, expected, data=None, request_id=None):
        started = time.time()
        tick = time.perf_counter()
        code, body, transport_error = None, None, None
        try:
            code, body = web(path, data)
        except Exception as error:
            transport_error = type(error).__name__ + ": " + str(error)
        item = {"phase": phase, "account": account, "op": op, "status": code,
                "elapsed_ms": round((time.perf_counter() - tick) * 1000, 3),
                "started_unix": round(started, 3)}
        if request_id:
            item["request_id"] = request_id
        if transport_error:
            item["transport_error"] = transport_error
        timeline.append(item)
        if transport_error or code != expected:
            raise AssertionError((item, body))
        return body

    def serve_agent(name, transport):
        while not stop_workers.is_set():
            if name == "a" and pause_a.is_set():
                time.sleep(.02)
                continue
            try:
                for item in transport.retrieve():
                    if name == "a" and pause_a.is_set():
                        break
                    if item["message_id"] in processed[name]:
                        continue
                    bridges[name].process(item, transport)
                    processed[name].add(item["message_id"])
            except Exception as error:
                if processes.get("platform") is not None:
                    worker_errors.append((name, type(error).__name__, str(error)))
            time.sleep(.04)

    def poll_complete(phase, name, account, rid):
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            body = timed(phase, name, "control_poll", account["web"],
                         f"/api/agents/{account['agent_id']}/control?request_id={rid}", 200,
                         request_id=rid)
            if body["status"] == "complete":
                assert body["response"]["request_id"] == rid, body
                return body
            assert body["status"] == "pending", body
            time.sleep(.08)
        raise AssertionError(f"control {name}/{rid} did not complete within 40 seconds")

    def run_round(number, accounts, executor):
        phase = "normal_before" if number <= 4 else "normal_after"
        futures = []
        request_ids = {}
        for name, account in accounts.items():
            web, agent_id = account["web"], account["agent_id"]
            rid = str(uuid.uuid4())
            request_ids[name] = rid
            control_path = f"/api/agents/{agent_id}/control"
            operations = [
                ("control_submit", control_path, 202,
                 {"request_id": rid, "method": "contacts.list", "params": {}}, rid),
                ("workspace_agent", f"/api/agents/{agent_id}/workspace", 200, None, None),
                ("workspace_agent", f"/api/agents/{agent_id}/workspace", 200, None, None),
                ("workspace_overview", "/api/workspace", 200, None, None),
                ("workspace_overview", "/api/workspace", 200, None, None),
                ("notifications", "/api/notifications", 200, None, None),
                ("push_settings", f"/api/notifications/push?deviceId={account['device_id']}", 200, None, None),
                ("sync_schedule", "/api/workspace/sync", 202, {"agentId": agent_id}, None),
                ("agents_list", "/api/agents", 200, None, None),
                ("platform_policy", "/api/platform-policy", 200, None, None),
            ]
            for op, path, expected, data, control_id in operations:
                futures.append(executor.submit(timed, phase, name, op, web, path, expected, data, control_id))
        for future in as_completed(futures):
            future.result()
        # Both control polls now overlap each other and fresh workspace reads.
        poll_futures = {}
        read_futures = []
        for name, account in accounts.items():
            poll_futures[name] = executor.submit(poll_complete, phase, name, account, request_ids[name])
            read_futures.append(executor.submit(timed, phase, name, "workspace_during_poll", account["web"],
                                                f"/api/agents/{account['agent_id']}/workspace", 200))
            read_futures.append(executor.submit(timed, phase, name, "overview_during_poll", account["web"],
                                                "/api/workspace", 200))
        for name, future in poll_futures.items():
            result = future.result()
            assert "contacts" in result["response"]["result"], name
        for future in read_futures:
            future.result()

    try:
        start_platform()
        for name in ("a", "b"):
            start(name, [str(args.helper.resolve()), "daemon", str(folder / f"agent-{name}-keys"),
                         urls["platform"], str(ports[name])])
        agents = {name: until(lambda name=name: request(urls[name], "/info"),
                              name + " helper", timeout=40) for name in ("a", "b")}
        assert agents["a"]["urn"] != agents["b"]["urn"]
        for name, agent in agents.items():
            until(lambda agent=agent: request(urls["platform"], "/api/v1/registry/resolve?urn=" + agent["urn"]).get("found"),
                  name + " agent registry", timeout=40)
        start("web", [str(args.node.resolve()), str(WEB / "node_modules/next/dist/bin/next"),
                      "start", "--hostname", "127.0.0.1", "--port", str(ports["web"])], cwd=WEB)
        accounts = {}
        for name, agent in agents.items():
            web = client()
            until(lambda: web("/api/auth/csrf")[0] == 200, "Web startup", timeout=40)
            email = f"{name}-{uuid.uuid4().hex}@example.invalid"
            password = secrets.token_urlsafe(36)
            expect(web, "/api/auth/register", 201, {"email": email, "password": password})
            csrf = expect(web, "/api/auth/csrf")["csrfToken"]
            expect(web, "/api/auth/callback/credentials", 200,
                   {"email": email, "password": password, "csrfToken": csrf,
                    "json": "true", "callbackUrl": urls["web"] + "/dashboard/agents"}, form=True)
            session = expect(web, "/api/auth/session")
            assert session["user"]["email"] == email
            connection = expect(web, "/api/agents", 201,
                                {"name": f"Stability agent {name}", "urn": agent["urn"]})
            identity = expect(web, f"/api/agents/{connection['id']}/bind-owner", 200, {})
            until(lambda identity=identity: request(urls["platform"],
                  "/api/v1/registry/resolve?urn=" + identity["virtualUrn"]).get("found"),
                  name + " console registry", timeout=40)
            owner = f"local-owner-{name}"
            store = Store(folder / f"store-{name}.sqlite3", local_urn=agent["urn"])
            bridge = RemoteBridge(folder / f"remote-{name}.sqlite3", store, agent["urn"])
            bridge.pair(identity["virtualUrn"], owner, [*READ_METHODS, "contacts.add"],
                        (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z"))
            stores[name], bridges[name] = store, bridge
            accounts[name] = {"web": web, "agent_id": connection["id"],
                              "user_id": session["user"]["id"], "urn": identity["virtualUrn"],
                              "device_id": str(uuid.uuid4()), "owner": owner}
        assert accounts["a"]["urn"] != accounts["b"]["urn"]
        assert accounts["a"]["web"](f"/api/agents/{accounts['b']['agent_id']}/workspace")[0] == 404
        for name in ("a", "b"):
            transport = HelperTransport(urls[name])
            thread = threading.Thread(target=serve_agent, args=(name, transport), daemon=True)
            thread.start()
            workers.append(thread)

        with ThreadPoolExecutor(max_workers=parallel) as executor:
            for number in range(1, 5):
                run_round(number, accounts, executor)

            # The single planned outage occurs after Platform accepted one durable
            # control request but before agent A consumes it.
            pause_a.set()
            time.sleep(.15)
            account = accounts["a"]
            fault_id = str(uuid.uuid4())
            fault_params = {"contact_id": "fault-contact", "aliases": ["fault recovery contact"],
                            "urn": "urn:agent-comm:agent:fault-contact"}
            fault_body = {"request_id": fault_id, "method": "contacts.add", "params": fault_params}
            control_path = f"/api/agents/{account['agent_id']}/control"
            queued = timed("injected", "a", "contact_submit", account["web"], control_path,
                           202, fault_body, fault_id)
            assert queued["status"] == "pending"
            stop("platform")
            outage = timed("injected", "a", "control_poll_during_outage", account["web"],
                           control_path + "?request_id=" + fault_id, 503, request_id=fault_id)
            assert outage["error"]
            start_platform()
            pause_a.clear()
            final = poll_complete("recovery", "a", account, fault_id)
            assert final["response"]["result"]["status"] == "requested", final
            duplicate = timed("recovery", "a", "same_id_replay", account["web"],
                              control_path, 200, fault_body, fault_id)
            assert duplicate["status"] == "complete"
            assert duplicate["response"] == final["response"]
            with sqlite3.connect(folder / "store-a.sqlite3") as db:
                contact_count = db.execute("SELECT COUNT(*) FROM collaboration_records WHERE kind='contact' AND id='fault-contact'").fetchone()[0]
                audit_count = sum(json.loads(row[0]).get("event") == "remote_contact_added" and
                                  json.loads(row[0]).get("contact_id") == "fault-contact"
                                  for row in db.execute("SELECT body FROM collaboration_records WHERE kind='audit'"))
            with sqlite3.connect(database) as db:
                web_count = db.execute("SELECT COUNT(*) FROM ControlRequest WHERE id=?", (fault_id,)).fetchone()[0]
            assert (contact_count, audit_count, web_count) == (1, 1, 1), (contact_count, audit_count, web_count)

            for number in range(5, 9):
                run_round(number, accounts, executor)

        # Let the actual background sync worker and both bridges settle.
        def sync_ready(name):
            code, body = accounts[name]["web"](f"/api/agents/{accounts[name]['agent_id']}/workspace")
            return body if code == 200 and body["sync"]["status"] == "ready" else None
        sync_states = {name: until(lambda name=name: sync_ready(name), name + " sync ready", timeout=40)["sync"]["status"]
                       for name in ("a", "b")}
        assert not worker_errors, worker_errors
        assert all(process.poll() is None for process in processes.values())
        assert all(len(processed[name]) >= rounds for name in ("a", "b")), processed
        with sqlite3.connect(database) as db:
            web_quick_check = db.execute("PRAGMA quick_check").fetchone()[0]
            completed_controls = db.execute("SELECT COUNT(*) FROM ControlRequest WHERE status='complete'").fetchone()[0]
        with sqlite3.connect(folder / "platform-data" / "mq.db") as db:
            mq_quick_check = db.execute("PRAGMA quick_check").fetchone()[0]
        assert web_quick_check == mq_quick_check == "ok"
        assert completed_controls >= 17, completed_controls

        normal = [item for item in timeline if item["phase"].startswith("normal")]
        assert len(normal) >= config["planned_non_injection_http_minimum"], len(normal)
        assert all(item["status"] in (200, 202) and item["elapsed_ms"] <= 20000 for item in normal)
        assert not any("transport_error" in item for item in normal)
        logs_text = "\n".join((folder / name).read_text(encoding="utf-8", errors="replace")
                              for name in ("web.log", "platform.log", "a.log", "b.log"))
        code5_count = len(re.findall(r"(?:SQLite[^\n]{0,80}Code\s*5|SQLite[^\n]{0,80}code\s*5|database is locked)",
                                     logs_text, re.IGNORECASE))
        p2024_count = logs_text.count("P2024")
        p1008_count = logs_text.count("P1008")
        slow_poll_count = logs_text.count('"event":"slow_control_poll"')
        assert code5_count == p2024_count == p1008_count == 0, (code5_count, p2024_count, p1008_count)
        by_op = defaultdict(list)
        for item in normal:
            by_op[item["op"]].append(item["elapsed_ms"])
        latency = {op: {"count": len(values), "p50_ms": percentile(values, .5),
                        "p95_ms": percentile(values, .95), "p99_ms": percentile(values, .99),
                        "max_ms": round(max(values), 3)} for op, values in sorted(by_op.items())}
        report = {"result": "PASS", "case": config["case"], "scope": config["environment"],
                  "normal_http_completed": len(normal), "normal_status": dict(Counter(item["status"] for item in normal)),
                  "normal_http_5xx": sum((item["status"] or 0) >= 500 for item in normal),
                  "normal_transport_errors": sum("transport_error" in item for item in normal),
                  "latency": latency, "all_normal_p95_ms": percentile([item["elapsed_ms"] for item in normal], .95),
                  "all_normal_p99_ms": percentile([item["elapsed_ms"] for item in normal], .99),
                  "all_normal_max_ms": max(item["elapsed_ms"] for item in normal),
                  "control_poll_at_least_2s": sum(item["op"] == "control_poll" and item["elapsed_ms"] >= 2000 for item in normal),
                  "slow_poll_log_lines": slow_poll_count,
                  "SQLite_Code_5": code5_count, "P2024": p2024_count, "P1008": p1008_count,
                  "fault": {"injected_poll_status": 503, "same_request_id": fault_id,
                            "resume_status": final["status"], "same_id_replay_status": duplicate["status"],
                            "agent_contact_rows": contact_count, "agent_added_audits": audit_count,
                            "web_control_rows": web_count},
                  "final": {"sync_status": sync_states, "completed_control_rows": completed_controls,
                            "agent_processed_message_ids": {name: len(processed[name]) for name in ("a", "b")},
                            "observed_restarts": {"planned_platform": 1, "web": 0, "agent_a": 0, "agent_b": 0},
                            "web_quick_check": web_quick_check, "platform_mq_quick_check": mq_quick_check,
                            "worker_errors": worker_errors},
                  "limitations": config["limitations"], "evidence_dir": str(folder)}
        (folder / "timeline.jsonl").write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in
                                                   sorted(timeline, key=lambda item: item["started_unix"])) + "\n",
                                                encoding="utf-8")
        (folder / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except Exception as error:
        (folder / "failure.json").write_text(json.dumps({"result": "FAIL", "error_type": type(error).__name__,
             "error": str(error), "recorded_http": len(timeline)}, ensure_ascii=False, indent=2), encoding="utf-8")
        raise
    finally:
        (folder / "timeline.jsonl").write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in
                                                   sorted(timeline, key=lambda item: item["started_unix"])) + "\n",
                                                encoding="utf-8")
        stop_workers.set()
        for thread in workers:
            thread.join(timeout=2)
        for bridge in bridges.values():
            bridge.close()
        for store in stores.values():
            store.close()
        for name in list(processes):
            stop(name)
        for log in logs:
            log.close()


if __name__ == "__main__":
    main()

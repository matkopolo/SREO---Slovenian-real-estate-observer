"""Disposable Compose smoke test. Never imports GURS or touches the user's volumes.

Run from the checkout with Python 3 and Docker Compose (CI/developer check only).
Normal application startup does not require host Python.
"""
import json
import pathlib
import re
import subprocess
import tempfile
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True)


def main():
    config = json.loads(run("docker", "compose", "config", "--format", "json"))
    config.pop("name", None)
    # The worker would start a real GURS import; the API and frontend must start without it.
    config["services"].pop("pipeline-worker")
    for service in config["services"].values():
        service.pop("ports", None)
        service["pull_policy"] = "never"
    config["services"]["observer"]["ports"] = [
        {"target": 80, "published": "0", "host_ip": "127.0.0.1", "protocol": "tcp"}
    ]
    # compose config expands explicit names: remove them before selecting a new project.
    for resource in ("volumes", "networks"):
        for value in config.get(resource, {}).values():
            value.pop("name", None)
    project = "sreo-smoke-" + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix="sreo-smoke-") as directory:
        path = pathlib.Path(directory) / "compose.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        command = ["docker", "compose", "--project-name", project, "-f", str(path)]
        try:
            print(run(*command, "up", "-d", "--no-build", "--wait", "--wait-timeout", "300"), flush=True)
            print(run(*command, "run", "--rm", "--no-deps", "database-migrations"), flush=True)
            port = run(*command, "port", "observer", "80").strip()
            base = "http://" + port
            for endpoint in ("/", "/api/v1/meta", "/api/v1/data-status"):
                with urllib.request.urlopen(base + endpoint, timeout=30) as response:
                    assert response.status == 200
                    print(f"PASS {endpoint}: HTTP 200", flush=True)
            with urllib.request.urlopen(base + "/", timeout=30) as response:
                script = re.search(r'src="(/assets/[^"]+\.js)"', response.read().decode())
            assert script, "index.html references no hashed /assets/*.js"
            with urllib.request.urlopen(base + script.group(1), timeout=30) as response:
                assert "immutable" in ", ".join(response.headers.get_all("Cache-Control") or [])
                assert response.headers.get("X-Content-Type-Options") == "nosniff"
                print(f"PASS {script.group(1)}: immutable, nosniff", flush=True)
            print(run(*command, "exec", "-T", "db", "psql", "-U", "real_estate", "-d", "real_estate",
                      "-At", "-c", "SELECT postgis_version(); SELECT count(*) FROM public.schema_migrations;"))
            # The worker's least-privilege role can log in with the Compose default password.
            print(run(*command, "exec", "-T", "db", "psql", "-At",
                      "postgresql://real_estate_pipeline:real_estate_pipeline@localhost/real_estate",
                      "-c", "SELECT current_user, has_table_privilege('analytics.sale_facts', 'INSERT')"))
            print("PASS fresh-volume startup, repeat migrations, API readiness and same-origin frontend proxy")
        except Exception:
            print(run(*command, "logs", "--tail", "80"), flush=True)
            raise
        finally:
            # Only this newly generated test project and its disposable data are removed.
            print(run(*command, "down", "--volumes", "--remove-orphans"), flush=True)


if __name__ == "__main__":
    main()

"""Disposable Compose smoke test. Never imports GURS or touches the user's volumes.

Run from the checkout with Python 3 and Docker Compose (CI/developer check only).
Normal application startup does not require host Python.
"""
import json
import pathlib
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
    config["services"].pop("pipeline-worker")
    config["services"]["real-estate-api"]["depends_on"].pop("pipeline-worker")
    for service in config["services"].values():
        service.pop("ports", None)
        service["pull_policy"] = "never"
    config["services"]["web"]["ports"] = [
        {"target": 3000, "published": "0", "host_ip": "127.0.0.1", "protocol": "tcp"}
    ]
    # compose config expands explicit names: remove them before selecting a new project.
    for resource in ("volumes", "networks"):
        for value in config.get(resource, {}).values():
            value.pop("name", None)
    project = "domoglasnik-smoke-" + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix="domoglasnik-smoke-") as directory:
        path = pathlib.Path(directory) / "compose.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        command = ["docker", "compose", "--project-name", project, "-f", str(path)]
        try:
            print(run(*command, "up", "-d", "--no-build", "--wait", "--wait-timeout", "300"), flush=True)
            print(run(*command, "run", "--rm", "--no-deps", "database-migrations"), flush=True)
            port = run(*command, "port", "web", "3000").strip()
            for endpoint in ("/", "/api/v1/meta"):
                with urllib.request.urlopen("http://" + port + endpoint, timeout=30) as response:
                    assert response.status == 200
                    print(f"PASS {endpoint}: HTTP 200", flush=True)
            print(run(*command, "exec", "-T", "db", "psql", "-U", "real_estate", "-d", "real_estate",
                      "-At", "-c", "SELECT postgis_version(); SELECT count(*) FROM public.schema_migrations;"))
            print("PASS fresh-volume startup, repeat migrations, API readiness and same-origin web proxy")
        except Exception:
            print(run(*command, "logs", "--tail", "80"), flush=True)
            raise
        finally:
            # Only this newly generated test project and its disposable data are removed.
            print(run(*command, "down", "--volumes", "--remove-orphans"), flush=True)


if __name__ == "__main__":
    main()

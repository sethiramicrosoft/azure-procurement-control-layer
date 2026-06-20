import hashlib
import hmac
import logging
import os
import secrets
import subprocess
import threading
import time
from queue import Queue
from typing import Any, Dict

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("apcl-orchestrator")

job_queue: "Queue[Dict[str, Any]]" = Queue()
worker_started = False
az_logged_in = False


def env(name: str, default: Optional[str] = None) -> str:
    value = os.getenv(name, default)
    if value is None:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def verify_signature(raw_body: bytes, timestamp: str, signature: str) -> bool:
    secret = os.getenv("APCL_DEPLOYMENT_WEBHOOK_HMAC_SECRET", "")
    if not secret:
        return False
    message = f"{timestamp}.{raw_body.decode('utf-8')}".encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def run_az(args: list[str], timeout: int = 600) -> str:
    command = ["az"] + args
    proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    if proc.returncode != 0:
        stderr = (proc.stderr or proc.stdout or "az command failed").strip()
        raise RuntimeError(stderr)
    return (proc.stdout or "").strip()


def ensure_az_login() -> None:
    global az_logged_in
    if az_logged_in:
        return
    run_az(["login", "--identity", "--allow-no-subscriptions"], timeout=120)
    az_logged_in = True


def callback_status(execution_id: str, status: str, result_message: str) -> None:
    base_url = env("APCL_BASE_URL")
    url = f"{base_url.rstrip('/')}/api/deployments/status"
    status_token = env("APCL_DEPLOYMENT_STATUS_TOKEN").strip()
    headers = {
        "Content-Type": "application/json",
        "x-apcl-status-token": status_token,
    }
    payload = {
        "executionId": execution_id,
        "status": status,
        "resultMessage": result_message,
        "updatedAt": int(time.time()),
    }
    response = requests.post(url, headers=headers, json=payload, timeout=30)
    response.raise_for_status()


def create_vm(payload: Dict[str, Any]) -> str:
    subscription_id = env("AZURE_SUBSCRIPTION_ID")
    resource_group = env("AZURE_VM_RESOURCE_GROUP", "rg-apcl-prod-137")
    location = env("AZURE_VM_LOCATION", "eastus")
    vm_size = env("AZURE_VM_SIZE", "Standard_B1s")
    admin_user = env("AZURE_VM_ADMIN_USER", "azureuser")

    execution_id = payload.get("executionId", "unknown")
    requestor = payload.get("requestedBy", "unknown")
    vm_name = payload.get("vmName") or f"apcl-{execution_id[:10]}".lower()
    tags = {
        "source": "apcl",
        "executionId": execution_id,
        "requestedBy": requestor,
        "environment": payload.get("environment", "prod"),
    }

    ensure_az_login()
    run_az(["account", "set", "--subscription", subscription_id], timeout=120)

    vnet_name = f"{vm_name}-vnet"
    subnet_name = f"{vm_name}-subnet"
    pip_name = f"{vm_name}-pip"
    nic_name = f"{vm_name}-nic"

    tags_arg = " ".join([f"{k}={v}" for k, v in tags.items()])

    run_az(
        [
            "network",
            "vnet",
            "create",
            "--resource-group",
            resource_group,
            "--name",
            vnet_name,
            "--location",
            location,
            "--address-prefixes",
            "10.31.0.0/16",
            "--subnet-name",
            subnet_name,
            "--subnet-prefixes",
            "10.31.1.0/24",
            "--tags",
            tags_arg,
        ],
        timeout=300,
    )

    run_az(
        [
            "network",
            "public-ip",
            "create",
            "--resource-group",
            resource_group,
            "--name",
            pip_name,
            "--location",
            location,
            "--allocation-method",
            "Static",
            "--sku",
            "Standard",
            "--tags",
            tags_arg,
        ],
        timeout=300,
    )

    run_az(
        [
            "network",
            "nic",
            "create",
            "--resource-group",
            resource_group,
            "--name",
            nic_name,
            "--vnet-name",
            vnet_name,
            "--subnet",
            subnet_name,
            "--public-ip-address",
            pip_name,
            "--tags",
            tags_arg,
        ],
        timeout=300,
    )

    admin_password = f"Aa!{secrets.token_urlsafe(16)}"
    run_az(
        [
            "vm",
            "create",
            "--resource-group",
            resource_group,
            "--name",
            vm_name,
            "--location",
            location,
            "--nics",
            nic_name,
            "--image",
            "Ubuntu2204",
            "--size",
            vm_size,
            "--admin-username",
            admin_user,
            "--admin-password",
            admin_password,
            "--authentication-type",
            "password",
            "--tags",
            tags_arg,
        ],
        timeout=900,
    )

    vm_id = run_az(
        [
            "vm",
            "show",
            "--resource-group",
            resource_group,
            "--name",
            vm_name,
            "--query",
            "id",
            "--output",
            "tsv",
        ],
        timeout=120,
    )
    return vm_id or vm_name


def worker() -> None:
    logger.info("Worker started")
    while True:
        job = job_queue.get()
        execution_id = job["execution_id"]
        payload = job["payload"]
        try:
            try:
                callback_status(execution_id, "running", "VM provisioning started")
            except Exception:
                logger.exception("Failed sending running callback for execution %s", execution_id)
            vm_id = create_vm(payload)
            callback_status(execution_id, "succeeded", f"VM provisioned: {vm_id}")
            logger.info("Provisioning succeeded for execution %s", execution_id)
        except Exception as exc:
            logger.exception("Provisioning failed for execution %s", execution_id)
            try:
                callback_status(execution_id, "failed", str(exc))
            except Exception:
                logger.exception("Failed sending failure callback for execution %s", execution_id)
        finally:
            job_queue.task_done()


def start_worker_once() -> None:
    global worker_started
    if worker_started:
        return
    threading.Thread(target=worker, daemon=True).start()
    worker_started = True


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True}), 200


@app.post("/hook")
def hook():
    timestamp = request.headers.get("x-apcl-timestamp", "")
    signature = request.headers.get("x-apcl-signature", "")
    raw_body = request.get_data() or b"{}"

    if not timestamp or not signature:
        return jsonify({"error": "missing signature headers"}), 401
    if not verify_signature(raw_body, timestamp, signature):
        return jsonify({"error": "invalid signature"}), 401

    payload = request.get_json(silent=True) or {}
    execution_id = payload.get("executionId")
    if not execution_id:
        return jsonify({"error": "executionId is required"}), 400

    start_worker_once()
    job_queue.put({"execution_id": execution_id, "payload": payload})
    return jsonify({"accepted": True, "executionId": execution_id}), 202


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")))

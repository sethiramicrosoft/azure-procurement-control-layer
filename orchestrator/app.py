import hashlib
import hmac
import logging
import os
import secrets
import threading
import time
from queue import Queue
from typing import Any, Dict, Optional

import requests
from azure.identity import ManagedIdentityCredential
from azure.mgmt.compute import ComputeManagementClient
from azure.mgmt.network import NetworkManagementClient
from azure.mgmt.resource import ResourceManagementClient
from flask import Flask, jsonify, request

app = Flask(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("apcl-orchestrator")

job_queue: "Queue[Dict[str, Any]]" = Queue()
worker_started = False
credential: Optional[ManagedIdentityCredential] = None


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


def get_credential() -> ManagedIdentityCredential:
    global credential
    if credential is None:
        credential = ManagedIdentityCredential()
    return credential


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

    cred = get_credential()
    resource_client = ResourceManagementClient(cred, subscription_id)
    network_client = NetworkManagementClient(cred, subscription_id)
    compute_client = ComputeManagementClient(cred, subscription_id)

    resource_client.resource_groups.get(resource_group)

    vnet_name = f"{vm_name}-vnet"
    subnet_name = f"{vm_name}-subnet"
    pip_name = f"{vm_name}-pip"
    nic_name = f"{vm_name}-nic"

    network_client.virtual_networks.begin_create_or_update(
        resource_group,
        vnet_name,
        {
            "location": location,
            "address_space": {"address_prefixes": ["10.31.0.0/16"]},
            "subnets": [{"name": subnet_name, "address_prefix": "10.31.1.0/24"}],
            "tags": tags,
        },
    ).result()
    subnet = network_client.subnets.get(resource_group, vnet_name, subnet_name)

    pip = network_client.public_ip_addresses.begin_create_or_update(
        resource_group,
        pip_name,
        {
            "location": location,
            "public_ip_allocation_method": "Static",
            "sku": {"name": "Standard"},
            "tags": tags,
        },
    ).result()

    nic = network_client.network_interfaces.begin_create_or_update(
        resource_group,
        nic_name,
        {
            "location": location,
            "ip_configurations": [
                {
                    "name": "ipconfig1",
                    "subnet": {"id": subnet.id},
                    "public_ip_address": {"id": pip.id},
                }
            ],
            "tags": tags,
        },
    ).result()

    admin_password = f"Aa!{secrets.token_urlsafe(16)}"
    image_reference = {
        "publisher": "Canonical",
        "offer": "0001-com-ubuntu-server-jammy",
        "sku": "22_04-lts-gen2",
        "version": "latest",
    }

    vm = compute_client.virtual_machines.begin_create_or_update(
        resource_group,
        vm_name,
        {
            "location": location,
            "tags": tags,
            "hardware_profile": {"vm_size": vm_size},
            "storage_profile": {"image_reference": image_reference},
            "os_profile": {
                "computer_name": vm_name,
                "admin_username": admin_user,
                "admin_password": admin_password,
                "linux_configuration": {"disable_password_authentication": False},
            },
            "network_profile": {"network_interfaces": [{"id": nic.id, "primary": True}]},
        },
    ).result()

    return vm.id or vm_name


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

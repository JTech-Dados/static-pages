"""Fixtures dos testes E2E do static-pages.

Rodam contra um container já no ar (local ou CI):
    BASE_URL         padrão http://localhost:8080
    FB_ADMIN_USER    padrão admin
    FB_ADMIN_PASSWORD  obrigatório (ou lido do .env da raiz)
    BROWSER_CHANNEL  ex.: "msedge" para usar o Edge instalado (opcional)
    SP_CONTAINER     nome do container para `docker exec` (padrão static-pages)

Tudo que os testes criam usa o prefixo "zz-" / "zz." e é removido no final,
inclusive da lixeira — dá para rodar no servidor real sem tocar nos dados.
"""
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
import requests
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PREFIX = "zz-"


def _env_file(key):
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    return ""


BASE = os.environ.get("BASE_URL", "http://localhost:8080").rstrip("/")
ADMIN_USER = os.environ.get("FB_ADMIN_USER") or _env_file("FB_ADMIN_USER") or "admin"
ADMIN_PASS = os.environ.get("FB_ADMIN_PASSWORD") or _env_file("FB_ADMIN_PASSWORD")
CONTAINER = os.environ.get("SP_CONTAINER", "static-pages")


class Api:
    """Cliente mínimo da API do File Browser."""

    def __init__(self, user, password):
        r = requests.post(f"{BASE}/admin/api/login", json={"username": user, "password": password, "recaptcha": ""}, timeout=10)
        r.raise_for_status()
        self.token = r.text
        self.h = {"X-Auth": self.token}

    def req(self, method, path, **kw):
        return requests.request(method, f"{BASE}/admin/api{path}", headers={**self.h, **kw.pop("headers", {})}, timeout=15, **kw)

    def mkdir(self, path):
        return self.req("POST", f"/resources{path.rstrip('/')}/")

    def write(self, path, body):
        return self.req("POST", f"/resources{path}?override=true", data=body.encode())

    def delete(self, path):
        return self.req("DELETE", f"/resources{path}")

    def users(self):
        return self.req("GET", "/users").json()

    def add_user(self, username, password, scope):
        data = {"username": username, "password": password, "scope": scope, "locale": "pt-br", "lockPassword": False,
                "perm": {"admin": False, "execute": False, "create": True, "rename": True, "modify": True,
                         "delete": True, "share": False, "download": True},
                "commands": [], "rules": [], "hideDotfiles": True, "viewMode": "list"}
        return self.req("POST", "/users", json={"what": "user", "which": [], "data": data})

    def cleanup(self):
        """Remove usuários zz.*, pastas zz-* e o que elas deixaram na lixeira."""
        for u in self.users():
            if u["username"].startswith("zz."):
                self.req("DELETE", f"/users/{u['id']}")
        root = self.req("GET", "/resources/").json()
        for item in root.get("items", []):
            if item["isDir"] and item["name"].startswith(PREFIX):
                self.delete(f"/{item['name']}/")
        reg = self.req("GET", "/raw/_lixeira/.registro")
        if reg.ok:
            keep, drop = [], []
            for line in reg.text.splitlines():
                (drop if f"\t/{PREFIX}" in line else keep).append(line)
            for line in drop:
                # /_lixeira/<dia>/<lote>/... -> apaga o lote inteiro
                lote = "/".join(line.split("\t")[3].split("/")[:4])
                self.delete(lote + "/")
            if drop:
                self.write("/_lixeira/.registro", "\n".join(keep) + ("\n" if keep else ""))


@pytest.fixture(scope="session")
def admin():
    if not ADMIN_PASS:
        pytest.skip("defina FB_ADMIN_PASSWORD (ou no .env) para rodar os testes")
    api = Api(ADMIN_USER, ADMIN_PASS)
    api.cleanup()
    yield api
    api.cleanup()


@pytest.fixture
def uid():
    return uuid.uuid4().hex[:6]


@pytest.fixture(scope="session")
def browser():
    channel = os.environ.get("BROWSER_CHANNEL") or None
    with sync_playwright() as p:
        b = p.chromium.launch(channel=channel)
        yield b
        b.close()


@pytest.fixture
def page(browser):
    ctx = browser.new_context(viewport={"width": 1280, "height": 860})
    pg = ctx.new_page()
    pg.errors = []
    pg.on("console", lambda m: pg.errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    yield pg
    ctx.close()


def login(pg, user, password):
    pg.goto(f"{BASE}/admin/login")
    pg.fill("input[type=text]", user)
    pg.fill("input[type=password]", password)
    pg.keyboard.press("Enter")
    pg.wait_for_url("**/admin/files/**")
    pg.wait_for_load_state("networkidle")


def in_container(*cmd):
    """Roda um comando no container (pula o teste se não houver docker)."""
    if not shutil.which("docker"):
        pytest.skip("docker indisponível para executar no container")
    return subprocess.run(["docker", "exec", CONTAINER, *cmd], capture_output=True, text=True, check=True)

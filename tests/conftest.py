"""Fixtures dos testes E2E do Static Pages.

Rodam contra um container já no ar (local ou CI):
    BASE_URL         padrão http://localhost:8080 (com SP_BASE=/pages, use http://localhost:8080/pages)
    FB_ADMIN_USER    padrão admin
    FB_ADMIN_PASSWORD  obrigatório (ou lido do .env da raiz)
    BROWSER_CHANNEL  ex.: "msedge" para usar o Edge instalado (opcional)
    BROWSER_PATH     caminho de um Chromium já instalado (opcional)
    SP_CONTAINER     nome do container para `docker exec` (padrão static-pages)

Tudo que os testes criam usa o prefixo "zz-" / "zz." e é removido no final,
inclusive da lixeira — dá para rodar no servidor real sem tocar nos dados.
"""
import os
import time
import shutil
import subprocess
import uuid
from pathlib import Path
from urllib.parse import urlparse

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
BASE_PATH = urlparse(BASE).path.rstrip("/")   # prefixo público, ex.: "/pages" (vazio na raiz)
ADMIN_USER = os.environ.get("FB_ADMIN_USER") or _env_file("FB_ADMIN_USER") or "admin"
ADMIN_PASS = os.environ.get("FB_ADMIN_PASSWORD") or _env_file("FB_ADMIN_PASSWORD")
CONTAINER = os.environ.get("SP_CONTAINER", "static-pages")


class Api:
    """Cliente mínimo da API do File Browser."""

    def __init__(self, user, password):
        # o NGINX limita o login a 5/min por IP (rajada de 10): se a suíte estourar, espera a janela e tenta de novo
        for tentativa in range(6):
            r = requests.post(f"{BASE}/admin/api/login", json={"username": user, "password": password, "recaptcha": ""}, timeout=10)
            if r.status_code != 429:
                break
            time.sleep(13)
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

    def add_user(self, username, password, scope, leitor=False, admin=False):
        data = {"username": username, "password": password, "scope": scope, "locale": "pt-br", "lockPassword": False,
                "perm": {"admin": admin, "execute": admin, "create": not leitor, "rename": not leitor, "modify": not leitor,
                         "delete": not leitor, "share": admin, "download": True},
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
                # time restrito: desliga antes de apagar (senão fica o marcador de um time que não existe mais)
                try:
                    requests.put(f"{BASE}/admin/entra/site/acesso", json={"time": item["name"], "ativo": False, "emails": []}, headers=self.h, timeout=5)
                except requests.RequestException:
                    pass
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
        b = p.chromium.launch(channel=channel, executable_path=os.environ.get("BROWSER_PATH") or None)
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
    # o NGINX limita o login a 5/min por IP (rajada de 10): se outros testes gastaram a rajada, espera a janela
    # e tenta de novo (429 na resposta do login) em vez de falhar por tempo
    for tentativa in range(5):
        pg.goto(f"{BASE}/admin/login")
        pg.fill("input[type=text]", user)
        pg.fill("input[type=password]", password)
        with pg.expect_response(lambda r: r.url.endswith("/admin/api/login") and r.request.method == "POST", timeout=30000) as info:
            pg.keyboard.press("Enter")
        if info.value.status != 429:
            break
        time.sleep(13)
    # o 429 esperado não é erro do painel: não deixa o teste reclamar dele
    pg.errors[:] = [e for e in pg.errors if "429" not in e]
    pg.wait_for_url("**/admin/files/**")
    pg.wait_for_load_state("networkidle")


def login_token(pg, token):
    """Entra no painel reaproveitando um token, sem chamar /api/login.

    O NGINX limita o login a 5/min por IP (anti força-bruta); os testes
    usam o token de uma sessão já aberta para não estourar esse limite.
    """
    pg.goto(f"{BASE}/admin/login")
    pg.evaluate("t => localStorage.setItem('jwt', t)", token)
    pg.goto(f"{BASE}/admin/files/")
    pg.wait_for_url("**/admin/files/**")
    try:
        pg.wait_for_load_state("networkidle", timeout=8000)
    except Exception:
        pass  # painel com requisições longas (ex.: _pastas 401 de site restrito) — a tela já carregou


def in_container(*cmd):
    """Roda um comando no container (pula o teste se não houver docker)."""
    if not shutil.which("docker"):
        pytest.skip("docker indisponível para executar no container")
    return subprocess.run(["docker", "exec", CONTAINER, *cmd], capture_output=True, text=True, check=True)

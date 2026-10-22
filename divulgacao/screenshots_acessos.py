"""Prints das telas de acesso para o README (dados fictícios) -> docs/img/

Telas: login com Microsoft, Acessos e times, pessoas do time, aba Usuários, aba Pedidos,
Atividade (com eventos de acesso), visão de um membro (barra de espaço) e o guia /_ajuda/.

Cria times, pessoas e pedidos de demonstração temporários (removidos no final) e simula o
histórico interceptando a resposta, para que nenhum nome real do servidor apareça.
Precisa de um container com o Entra de teste (ENTRA_TENANT_ID, ENTRA_CLIENT_ID e ENTRA_JWKS_FILE),
porque os pedidos de acesso são criados com ID tokens assinados por uma chave de teste.

Uso:  FB_ADMIN_PASSWORD=... SP_CONTAINER=static-pages BASE_URL=http://localhost:8080 \
          python divulgacao/screenshots_acessos.py
"""
import base64
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))
from conftest import ADMIN_PASS, ADMIN_USER, BASE, CONTAINER, Api  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(__file__).parent.parent / "docs" / "img"
ENTRA = f"{BASE}/admin/entra"
SENHA = "SenhaDemo123456!"
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()

TEAMS = {
    "zz-vendas": ("Vendas", 500, ["ana.souza@exemplo.com", "bruno.lima@exemplo.com", "carla.dias@exemplo.com"], ["relatorio-mensal", "metas-2026"]),
    "zz-marketing": ("Marketing", 1, ["diego.alves@exemplo.com"], ["campanha-verao"]),
    "zz-produto": ("Produto", None, ["eva.martins@exemplo.com", "fabio.rocha@exemplo.com"], ["roadmap", "prototipo-app", "pesquisa-ux"]),
}
PEDIDOS = [("gustavo.nunes@exemplo.com", "Gustavo Nunes"), ("helena.prado@exemplo.com", "Helena Prado")]
NOMES = {"ana.souza@exemplo.com": "Ana Souza", "bruno.lima@exemplo.com": "Bruno Lima", "carla.dias@exemplo.com": "Carla Dias",
         "diego.alves@exemplo.com": "Diego Alves", "eva.martins@exemplo.com": "Eva Martins", "fabio.rocha@exemplo.com": "Fabio Rocha"}
FAKE_LOG = "\n".join([
    "2026-10-22T09:02:00Z\tana.souza@exemplo.com\tacesso_login\tEntrou com a conta Microsoft\t",
    "2026-10-22T09:10:00Z\tgustavo.nunes@exemplo.com\tacesso_pedido\tPediu acesso (Gustavo Nunes)\t",
    "2026-10-22T09:25:00Z\tadmin\tacesso_aprovado\tgustavo.nunes@exemplo.com no time Vendas\t",
    "2026-10-22T10:05:00Z\tadmin\tacesso_papel\tbruno.lima@exemplo.com: Editor para Admin\t",
    "2026-10-22T10:40:00Z\tdiego.alves@exemplo.com\tacesso_cota\tEnvio recusado: cota do time excedida (campanha.mp4)\t",
    "2026-10-22T11:15:00Z\tana.souza@exemplo.com\tafter_upload\t/srv/vendas/relatorio-mensal/index.html\t",
    "2026-10-22T11:42:00Z\teva.martins@exemplo.com\tafter_save\t/srv/produto/roadmap/index.html\t",
]) + "\n"


def entra_tokens():
    """Gera as chaves de teste, grava o JWKS no container e devolve mint(email, nome)."""
    cfg = requests.get(f"{ENTRA}/config", timeout=10).json()
    if not cfg.get("habilitado"):
        sys.exit("Entra ID desligado neste container")
    run = lambda *c: subprocess.run(["docker", "exec", CONTAINER, *c], capture_output=True, text=True, check=True).stdout.strip()
    tenant, jwks_path = run("printenv", "ENTRA_TENANT_ID"), run("printenv", "ENTRA_JWKS_FILE")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    kid = f"demo-{uuid.uuid4().hex[:8]}"
    nums = key.public_key().public_numbers()
    jwks = {"keys": [{"kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256", "n": b64u(nums.n.to_bytes(256, "big")), "e": b64u(nums.e.to_bytes(3, "big"))}]}
    subprocess.run(["docker", "exec", "-i", CONTAINER, "sh", "-c", f"cat > {jwks_path} && chmod 644 {jwks_path}"], input=json.dumps(jwks).encode(), check=True)

    def mint(email, nome):
        now = int(time.time())
        head = b64u(json.dumps({"alg": "RS256", "kid": kid, "typ": "JWT"}).encode())
        body = b64u(json.dumps({"iss": f"https://login.microsoftonline.com/{tenant}/v2.0", "tid": tenant, "aud": cfg["clientId"], "iat": now, "nbf": now,
                                "exp": now + 3600, "preferred_username": email, "name": nome, "jti": str(uuid.uuid4())}).encode())
        return f"{head}.{body}.{b64u(key.sign(f'{head}.{body}'.encode(), padding.PKCS1v15(), hashes.SHA256()))}"
    return mint


def setup(api, mint):
    creds = {}
    for slug, (nome, cota, pessoas, paginas) in TEAMS.items():
        api.write(f"/{slug}/.time.json", json.dumps({"nome": nome, **({"cota_mb": cota} if cota else {})}))
        api.write(f"/{slug}/index.html", "<h1>time</h1>")
        for p in paginas:
            api.write(f"/{slug}/{p}/index.html", "<h1>pagina</h1>" + "x" * 40000)
        for u in pessoas:
            api.add_user(f"zz.{u}", SENHA, f"/{slug}")
            # o login Microsoft guarda o nome (é o que a tela mostra) e troca a senha: guardamos a nova
            r = requests.post(f"{ENTRA}/login", json={"idToken": mint(f"zz.{u}", NOMES[u])}, timeout=10)
            creds[u] = r.json()
    api.write("/zz-marketing/campanha-verao/dados.json", "x" * 680_000)   # ~70% da cota de 1 MB
    for email, nome in PEDIDOS:
        requests.post(f"{ENTRA}/solicitar", json={"idToken": mint(email, nome)}, timeout=10)
    return creds


def cleanup(api):
    api.cleanup()
    for email, _ in PEDIDOS:
        requests.post(f"{ENTRA}/pedidos/remover", json={"email": email}, headers=api.h, timeout=10)


def shoot():
    OUT.mkdir(parents=True, exist_ok=True)
    api = Api(ADMIN_USER, ADMIN_PASS)
    api.cleanup()
    mint = entra_tokens()
    creds = setup(api, mint)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL") or None, executable_path=os.environ.get("BROWSER_PATH") or None)
            ctx = lambda h=860: b.new_context(viewport={"width": 1280, "height": h}, device_scale_factor=2)
            # nomes "zz." e "/zz-" nunca aparecem: troca no DOM antes do print
            clean = """() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                for (let n; (n = w.nextNode());) n.nodeValue = n.nodeValue.replace(/\\bzz[.-]/g, ""); }"""

            anon = ctx().new_page()
            anon.goto(f"{BASE}/admin/login")
            anon.wait_for_selector(".sp-entra button", timeout=15000)
            anon.wait_for_timeout(600)
            anon.screenshot(path=OUT / "login.png")
            anon.goto(f"{BASE}/_ajuda/", wait_until="networkidle")
            anon.screenshot(path=OUT / "guia.png", clip={"x": 0, "y": 0, "width": 1280, "height": 860})

            pg = ctx().new_page()
            pg.goto(f"{BASE}/admin/login")
            pg.evaluate("t => localStorage.setItem('jwt', t)", api.token)
            pg.goto(f"{BASE}/admin/times", wait_until="networkidle")
            pg.wait_for_timeout(1500)
            pg.evaluate(clean)
            box = pg.locator("#teams-section").bounding_box()
            pg.screenshot(path=OUT / "times.png", clip={"x": 0, "y": 0, "width": 1280, "height": box["y"] + box["height"] + 24})

            pg.locator("article.card").first.locator(".team-title h3").click()
            pg.wait_for_selector("#dlg-people[open]")
            pg.evaluate(clean)
            pg.wait_for_timeout(300)
            pg.screenshot(path=OUT / "pessoas.png")
            pg.click("#people-close")

            pg.goto(f"{BASE}/admin/times#usuarios", wait_until="networkidle")
            pg.wait_for_timeout(1200)
            pg.evaluate(clean)
            pg.screenshot(path=OUT / "usuarios.png", clip={"x": 0, "y": 0, "width": 1280, "height": 760})

            pg.goto(f"{BASE}/admin/times#acessos", wait_until="networkidle")
            pg.wait_for_timeout(1200)
            pg.evaluate(clean)
            pg.screenshot(path=OUT / "pedidos.png", clip={"x": 0, "y": 0, "width": 1280, "height": 560})

            pg.route("**/admin/_auditoria", lambda r: r.fulfill(body=FAKE_LOG, content_type="text/plain"))
            pg.goto(f"{BASE}/admin/times#atividade", wait_until="networkidle")
            pg.wait_for_timeout(1000)
            pg.evaluate(clean)
            pg.screenshot(path=OUT / "atividade.png", clip={"x": 0, "y": 0, "width": 1280, "height": 660})

            membro = Api(creds["diego.alves@exemplo.com"]["usuario"], creds["diego.alves@exemplo.com"]["senha"])
            mp = ctx(600).new_page()
            mp.goto(f"{BASE}/admin/login")
            mp.evaluate("t => localStorage.setItem('jwt', t)", membro.token)
            mp.goto(f"{BASE}/admin/files/", wait_until="networkidle")
            mp.wait_for_timeout(1500)
            mp.evaluate(clean)
            mp.screenshot(path=OUT / "membro.png")
            b.close()
    finally:
        cleanup(api)
    print("ok:", sorted(f.name for f in OUT.glob("*.png")))


if __name__ == "__main__":
    shoot()

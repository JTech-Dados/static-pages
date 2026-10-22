"""Login Microsoft (sp-auth): pedidos de acesso, aprovação na tela de Times e login por token.

Só roda com o Entra configurado no container de teste (CI e local):
    ENTRA_TENANT_ID, ENTRA_CLIENT_ID e ENTRA_JWKS_FILE (chaves de teste, em vez do Entra).
Sem isso, os testes são pulados. O MSAL em si (popup da Microsoft) não é exercitado:
os testes geram ID tokens assinados com uma chave de teste, no formato do Entra.
"""
import base64
import json
import subprocess
import time
import uuid

import pytest
import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from playwright.sync_api import expect

from conftest import BASE, CONTAINER, Api, in_container, login_token

ENTRA = f"{BASE}/admin/entra"
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()


@pytest.fixture(scope="module")
def idp():
    cfg = requests.get(f"{ENTRA}/config", timeout=10).json()
    if not cfg.get("habilitado"):
        pytest.skip("Entra ID desligado neste container")
    try:
        tenant = in_container("printenv", "ENTRA_TENANT_ID").stdout.strip()
        jwks_path = in_container("printenv", "ENTRA_JWKS_FILE").stdout.strip()
    except subprocess.CalledProcessError:
        jwks_path = ""
    if not jwks_path:
        pytest.skip("container sem ENTRA_JWKS_FILE (chaves de teste): não dá para assinar tokens")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    kid = f"teste-{uuid.uuid4().hex[:8]}"   # kid novo a cada execução: o sp-auth relê o arquivo ao ver um kid desconhecido
    nums = key.public_key().public_numbers()
    jwks = {"keys": [{"kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256",
                      "n": b64u(nums.n.to_bytes(256, "big")), "e": b64u(nums.e.to_bytes(3, "big"))}]}
    subprocess.run(["docker", "exec", "-i", CONTAINER, "sh", "-c", f"cat > {jwks_path} && chmod 644 {jwks_path}"],
                   input=json.dumps(jwks).encode(), check=True)

    def mint(email, nome="Pessoa Teste"):
        now = int(time.time())
        head = b64u(json.dumps({"alg": "RS256", "kid": kid, "typ": "JWT"}).encode())
        body = b64u(json.dumps({
            "iss": f"https://login.microsoftonline.com/{tenant}/v2.0", "tid": tenant, "aud": cfg["clientId"],
            "iat": now, "nbf": now, "exp": now + 3600, "preferred_username": email, "name": nome,
            "jti": str(uuid.uuid4()),
        }).encode())
        sig = key.sign(f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())
        return f"{head}.{body}.{b64u(sig)}"

    return mint


def cria_time(admin, slug, nome):
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": nome, "cota_mb": None}))
    admin.write(f"/{slug}/index.html", "<h1>ok</h1>")


def test_botao_microsoft_na_tela_de_login(page, idp):
    page.goto(f"{BASE}/admin/login")
    botao = page.locator(".sp-entra button", has_text="Entrar com Microsoft")
    expect(botao).to_be_visible(timeout=15000)
    # vem antes dos campos de usuário e senha, como nas outras apps do portal
    assert botao.bounding_box()["y"] < page.locator("#login input[type=text]").bounding_box()["y"]
    assert page.errors == []


def test_token_invalido_e_recusado(idp):
    r = requests.post(f"{ENTRA}/login", json={"idToken": "a.b.c"}, timeout=10)
    assert r.status_code == 401
    assert requests.get(f"{ENTRA}/pedidos", timeout=10).status_code == 403   # sem token de admin


def test_membro_entra_pela_microsoft(idp, admin, uid):
    slug, email = f"zz-ent-{uid}", f"zz.membro{uid}@teste.com"
    cria_time(admin, slug, f"Time Entra {uid}")
    assert admin.add_user(email, "Senha-Inicial-123", f"/{slug}").ok

    r = requests.post(f"{ENTRA}/login", json={"idToken": idp(email.upper())}, timeout=10)   # e-mail em maiúsculas
    assert r.status_code == 200, r.text
    creds = r.json()
    assert creds["usuario"] == email and len(creds["senha"]) >= 24

    # a senha devolvida abre o painel nativo, restrito ao time (a troca da senha antiga está nos testes unitários)
    membro = Api(creds["usuario"], creds["senha"])
    nomes = [i["name"] for i in membro.req("GET", "/resources/").json().get("items", [])]
    assert "index.html" in nomes and not any(n.startswith("zz-") and n != "index.html" for n in nomes)


def test_pedido_de_acesso_aprovado_na_tela_de_times(idp, admin, page, uid):
    slug, nome = f"zz-ped-{uid}", f"Time Pedido {uid}"
    email = f"zz.novo{uid}@teste.com"
    cria_time(admin, slug, nome)

    # sem cadastro: recusa com "sem_acesso", pede acesso e fica pendente
    token = idp(email, "Novo Usuário")   # a tela usa o mesmo token no /login e no /solicitar
    r = requests.post(f"{ENTRA}/login", json={"idToken": token}, timeout=10)
    assert r.status_code == 403 and r.json() == {"erro": "sem_acesso", "pedido": None}
    r = requests.post(f"{ENTRA}/solicitar", json={"idToken": token}, timeout=10)
    assert r.status_code == 200 and r.json()["pedido"] == "pendente"

    login_token(page, admin.token)
    # em qualquer tela do painel o admin vê o aviso e o contador no menu
    expect(page.locator("[data-sp-pending]")).to_be_visible(timeout=15000)
    expect(page.locator("[data-sp-pending]")).to_contain_text("pedido")
    expect(page.locator("nav [data-sp-times] [data-sp-badge]")).to_be_visible()
    page.locator("[data-sp-pending]").click()
    page.wait_for_url("**/admin/times#acessos")
    linha = page.locator("#access tr", has_text=email)
    expect(linha).to_be_visible(timeout=20000)
    expect(page.locator("#acc-badge")).not_to_be_empty()
    linha.locator("select").select_option(label=nome)
    linha.get_by_role("button", name="Aprovar").click()
    expect(page.locator("#access tr", has_text=email)).to_have_count(0, timeout=20000)

    usuario = next(u for u in admin.users() if u["username"] == email)
    assert usuario["scope"] == f"/{slug}" and not usuario["perm"]["admin"] and usuario["lockPassword"]
    pedidos = requests.get(f"{ENTRA}/pedidos", headers=admin.h, timeout=10).json()
    assert all(p["email"] != email for p in pedidos)

    # agora a pessoa entra
    r = requests.post(f"{ENTRA}/login", json={"idToken": idp(email)}, timeout=10)
    assert r.status_code == 200 and r.json()["usuario"] == email
    assert page.errors == []


def test_pedido_recusado_nao_volta_a_pendente(idp, admin, uid):
    email = f"zz.recusa{uid}@teste.com"
    assert requests.post(f"{ENTRA}/solicitar", json={"idToken": idp(email)}, timeout=10).status_code == 200
    r = requests.post(f"{ENTRA}/pedidos/recusar", json={"email": email}, headers=admin.h, timeout=10)
    assert r.status_code == 200
    r = requests.post(f"{ENTRA}/solicitar", json={"idToken": idp(email)}, timeout=10)
    assert r.json()["pedido"] == "recusado"
    requests.post(f"{ENTRA}/pedidos/remover", json={"email": email}, headers=admin.h, timeout=10)


def test_admin_com_conta_de_email_tambem_entra_pela_microsoft(idp, admin, uid):
    """Quem é promovido a admin não pode ficar trancado para fora: conta de e-mail entra, admin local não."""
    email = f"zz.chefe{uid}@teste.com"
    assert admin.add_user(email, "Senha-Inicial-123", "/").ok
    u = next(x for x in admin.users() if x["username"] == email)
    perm = {k: True for k in ("admin", "execute", "create", "rename", "modify", "delete", "share", "download")}
    assert admin.req("PUT", f"/users/{u['id']}", json={"what": "user", "which": ["perm"], "data": {"id": u["id"], "perm": perm}}).ok
    r = requests.post(f"{ENTRA}/login", json={"idToken": idp(email)}, timeout=10)
    assert r.status_code == 200 and r.json()["usuario"] == email
    # o admin local não tem "@": nenhum e-mail casa com ele
    r = requests.post(f"{ENTRA}/login", json={"idToken": idp("admin@teste.com")}, timeout=10)
    assert r.status_code == 403 and r.json()["erro"] == "sem_acesso"

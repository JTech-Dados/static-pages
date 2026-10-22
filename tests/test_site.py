"""Site público, NGINX e regras de segurança."""
import uuid

import requests

from conftest import BASE, BASE_PATH


def get(path, **kw):
    return requests.get(BASE + path, timeout=10, allow_redirects=False, **kw)


def test_healthz():
    assert get("/healthz").status_code == 200


def test_home_e_404():
    assert get("/").status_code == 200
    r = get("/zz-nao-existe-mesmo")
    assert r.status_code == 404
    assert "não foi encontrada" in r.text


def test_admin_redireciona_com_barra():
    r = get("/admin")
    assert r.status_code == 301 and r.headers["Location"] == BASE_PATH + "/admin/"


def test_headers_de_seguranca_e_sandbox():
    h = get("/").headers
    assert h["X-Content-Type-Options"] == "nosniff"
    assert "sandbox" in h["Content-Security-Policy"]
    assert "allow-same-origin" not in h["Content-Security-Policy"]
    assert h.get("Server") == "nginx"  # sem versão (server_tokens off)


def test_dotfiles_e_pastas_internas_bloqueados(admin, uid):
    pasta = f"/zz-dot-{uid}"
    admin.write(f"{pasta}/.env", "SEGREDO=1")
    admin.write(f"{pasta}/.autoria", "x")
    assert get(f"{pasta}/.env").status_code == 404
    assert get(f"{pasta}/.autoria").status_code == 404
    assert get("/_lixeira/").status_code == 404
    assert get("/_lixeira/.registro").status_code == 404
    assert get("/_backup/").status_code == 404


def test_time_json_da_raiz_e_publico_mas_so_ele(admin, uid):
    pasta = f"/zz-pub-{uid}"
    admin.write(f"{pasta}/.time.json", '{"nome":"Público"}')
    admin.write(f"{pasta}/sub/.time.json", '{"nome":"Interno"}')
    assert get(f"{pasta}/.time.json").json()["nome"] == "Público"
    assert get(f"{pasta}/sub/.time.json").status_code == 404


def test_listagem_de_pastas_nao_sai_de_srv():
    for path in ["/_pastas/../", "/_pastas/%2e%2e/", "/_pastas/..%2f/", "/_pastas/../../etc/"]:
        r = requests.get(BASE + path, timeout=10)
        # o NGINX normaliza o caminho: ou cai na home (HTML) ou 404 — nunca lista fora de /srv
        assert r.status_code in (200, 404)
        assert not r.headers.get("content-type", "").startswith("application/json") or "etc" not in r.text


def test_listagem_json_com_cors():
    r = get("/_pastas/")
    assert r.status_code == 200
    assert r.headers["Access-Control-Allow-Origin"] == "*"
    assert isinstance(r.json(), list)


def test_auditoria_so_para_admin(admin, uid):
    assert get("/admin/_auditoria").status_code == 401
    assert get("/admin/_auditoria", headers={"X-Auth": "a.b.c"}).status_code == 401
    assert get("/admin/_auditoria", headers={"X-Auth": admin.token}).status_code == 200

    user, pw = f"zz.aud{uid}", "SenhaTeste123456"
    admin.add_user(user, pw, f"/zz-aud-{uid}")
    from conftest import Api
    membro = Api(user, pw)
    assert get("/admin/_auditoria", headers={"X-Auth": membro.token}).status_code == 403


def test_home_404_e_favicon_vem_da_imagem(admin):
    """A home não depende do /srv/index.html (que pode ser a cópia antiga do 1º deploy)."""
    home = requests.get(f"{BASE}/", timeout=10)
    assert home.status_code == 200 and "Static Pages" in home.text
    assert "organizadas por time" not in home.text
    assert requests.get(f"{BASE}/index.html", timeout=10).text == home.text
    assert requests.get(f"{BASE}/favicon.svg", timeout=10).status_code == 200
    ruim = requests.get(f"{BASE}/nao-existe-{uuid.uuid4().hex[:6]}/", timeout=10)
    assert ruim.status_code == 404 and "__SP_BASE__" not in ruim.text

    # um /srv/index.html diferente (como o do servidor antigo) não muda a home
    antigo = admin.req("GET", "/raw/index.html")
    admin.write("/index.html", "<h1>copia antiga</h1>")
    try:
        assert "copia antiga" not in requests.get(f"{BASE}/", timeout=10).text
    finally:
        admin.write("/index.html", antigo.text if antigo.ok else "<h1>x</h1>")


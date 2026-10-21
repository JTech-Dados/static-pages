"""Site público, NGINX e regras de segurança."""
import requests

from conftest import BASE


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
    assert r.status_code == 301 and r.headers["Location"] == "/admin/"


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

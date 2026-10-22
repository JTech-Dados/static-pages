"""Tokens de API pessoais: a automação troca o token por uma sessão e usa a API do File Browser.

Só roda com o Entra ligado no container (o recurso depende do mesmo mecanismo de troca de senha).
Os limites por IP (429) não entram aqui: o IP compartilhado interferiria nos outros testes.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import requests

from playwright.sync_api import expect

from conftest import BASE, Api, login_token

ENTRA = f"{BASE}/admin/entra"
SENHA = "SenhaTeste123456"
HTML = "<!doctype html><title>t</title><h1>relatório</h1>"


@pytest.fixture(scope="module", autouse=True)
def entra_ligado():
    if not requests.get(f"{ENTRA}/config", timeout=10).json().get("habilitado"):
        pytest.skip("Entra ID desligado neste container")


def cria_token(api, nome="job", dias=90):
    r = requests.post(f"{ENTRA}/api/tokens", json={"nome": nome, "dias": dias}, headers=api.h, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def sessao(token):
    r = requests.post(f"{ENTRA}/api/sessao", json={"token": token}, timeout=10)
    return r


def api_com_token(token):
    """Cliente da API do File Browser com a sessão obtida pelo token (sem login por senha)."""
    r = sessao(token)
    assert r.status_code == 200, r.text
    a = Api.__new__(Api)
    a.token = r.json()["jwt"]
    a.h = {"X-Auth": a.token}
    return a


def cria_time(admin, slug, cota=None):
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": slug, **({"cota_mb": cota} if cota else {})}))
    admin.write(f"/{slug}/index.html", "<h1>time</h1>")


def test_editor_publica_atualiza_e_apaga_com_token(admin, uid):
    slug, email = f"zz-tok-{uid}", f"zz.editor{uid}@exemplo.com"
    cria_time(admin, slug, cota=1)
    assert admin.add_user(email, SENHA, f"/{slug}").ok
    painel = Api(email, SENHA)
    tok = cria_token(painel)
    assert tok["papel"] == "editor" and tok["token"].startswith("sp_")

    auto = api_com_token(tok["token"])
    # publica (cria a pasta e o index.html); repetir sem override é recusado pelo servidor
    assert auto.req("POST", "/resources/relatorio/index.html?override=false", data=HTML.encode("utf-8"), headers={"Content-Type": "text/html"}).status_code == 200
    assert requests.get(f"{BASE}/{slug}/relatorio/", timeout=10).text == HTML
    assert auto.req("POST", "/resources/relatorio/index.html?override=false", data=b"<h1>outra</h1>").status_code == 409
    assert auto.req("POST", "/resources/relatorio/index.html?override=true", data=b"<h1>v2</h1>").status_code == 200
    assert requests.get(f"{BASE}/{slug}/relatorio/", timeout=10).text == "<h1>v2</h1>"
    # autoria: o dono do token aparece como autor na pasta nova
    autoria = admin.req("GET", f"/raw/{slug}/relatorio/.autoria")
    assert autoria.ok and email in autoria.text, autoria.text

    # a sessão do painel (obtida por senha) continua válida depois da troca de senha feita pelo token
    assert painel.req("GET", "/resources/").status_code == 200

    # não alcança outro time
    outro = f"zz-tok2-{uid}"
    cria_time(admin, outro)
    nomes = [i["name"] for i in auto.req("GET", "/resources/").json()["items"]]
    assert outro not in nomes and slug not in nomes
    # (%2e%2e: o requests colapsaria ".." antes de enviar)
    assert auto.req("GET", f"/resources/%2e%2e/{outro}/").status_code in (400, 403, 404)
    assert auto.req("POST", f"/resources/%2e%2e/{outro}/x.html", data=b"x").status_code in (400, 403, 404)
    assert "x.html" not in [i["name"] for i in admin.req("GET", f"/resources/{outro}/").json()["items"]]

    # cota: 1 MB; acima disso, 413 com a mensagem em português; sem Content-Length (chunked), 411
    r = auto.req("POST", "/resources/grande.bin?override=true", data=b"x" * 1_200_000)
    assert r.status_code == 413 and "cota" in r.text, (r.status_code, r.text)
    chunked = auto.req("POST", "/resources/pedaco.bin?override=true", data=(b"x" * 10 for _ in range(3)))
    assert chunked.status_code == 411, (chunked.status_code, chunked.text)

    # apagar vai para a lixeira (restaurável pela aba Lixeira) e publicar de novo funciona
    assert auto.req("DELETE", "/resources/relatorio/index.html").status_code == 204
    assert f"/{slug}/relatorio/index.html" in admin.req("GET", "/raw/_lixeira/.registro").text
    assert auto.req("POST", "/resources/relatorio/index.html?override=false", data=b"<h1>v3</h1>").status_code == 200

    # revogar pela API: a próxima troca falha
    assert requests.post(f"{ENTRA}/api/tokens/revogar", json={"id": tok["id"]}, headers=painel.h, timeout=10).status_code == 200
    assert sessao(tok["token"]).status_code == 401
    lista = requests.get(f"{ENTRA}/api/tokens", headers=painel.h, timeout=10).json()
    assert lista == []


def test_envio_grande_passa_pela_checagem_de_cota(admin, uid):
    """Regressão: a subrequisição de cota herdava client_max_body_size 1m e todo envio acima de 1 MB dava 500."""
    slug = f"zz-tokg-{uid}"
    cria_time(admin, slug, cota=50)
    assert admin.req("POST", f"/resources/{slug}/medio.bin?override=true", data=b"x" * 3_000_000).status_code == 200
    assert admin.req("POST", "/resources/zz-grande-{}.bin?override=true".format(uid), data=b"x" * 3_000_000).status_code == 200
    admin.delete(f"/zz-grande-{uid}.bin")


def test_leitor_com_token_so_le(admin, uid):
    slug, email = f"zz-tokl-{uid}", f"zz.leitor{uid}@exemplo.com"
    cria_time(admin, slug)
    admin.write(f"/{slug}/fixo.txt", "so leitura")
    assert admin.add_user(email, SENHA, f"/{slug}", leitor=True).ok
    tok = cria_token(Api(email, SENHA))
    assert tok["papel"] == "leitor"
    auto = api_com_token(tok["token"])
    assert auto.req("GET", "/raw/fixo.txt").text == "so leitura"
    assert auto.req("POST", "/resources/novo/index.html", data=b"x").status_code == 403
    assert auto.req("DELETE", "/resources/fixo.txt").status_code == 403
    assert auto.req("PUT", "/resources/fixo.txt", data=b"alterado").status_code == 403


def test_admin_por_email_com_token_e_validade_curta(admin, uid):
    slug, email = f"zz-toka-{uid}", f"zz.admin{uid}@exemplo.com"
    cria_time(admin, slug)
    assert admin.add_user(email, SENHA, "/", admin=True).ok
    painel = Api(email, SENHA)
    # admin: no máximo 90 dias
    r = requests.post(f"{ENTRA}/api/tokens", json={"nome": "ci", "dias": 365}, headers=painel.h, timeout=10)
    assert r.status_code == 400 and r.json()["erro"] == "validade_invalida"
    tok = cria_token(painel, "ci", 90)
    assert tok["papel"] == "admin"
    auto = api_com_token(tok["token"])
    # sessão de admin: enxerga e escreve em qualquer time
    assert auto.req("GET", f"/resources/{slug}/").status_code == 200
    assert auto.req("POST", f"/resources/{slug}/auto/index.html?override=false", data=HTML.encode("utf-8")).status_code == 200
    assert requests.get(f"{BASE}/{slug}/auto/", timeout=10).status_code == 200


def test_token_invalido_e_admin_local_sem_token(admin):
    for corpo in ({"token": "sp_" + "a" * 43}, {"token": "lixo"}, {}):
        r = sessao(corpo.get("token", "")) if corpo else requests.post(f"{ENTRA}/api/sessao", json={}, timeout=10)
        assert r.status_code == 401 and r.json() == {"erro": "token_invalido"}
    # o admin local (sem @) só entra por senha: não gera token
    r = requests.post(f"{ENTRA}/api/tokens", json={"nome": "x"}, headers=admin.h, timeout=10)
    assert r.status_code == 403
    # sem sessão
    assert requests.post(f"{ENTRA}/api/tokens", json={"nome": "x"}, timeout=10).status_code == 401


def test_tela_tokens_de_api_cria_lista_e_revoga(page, admin, uid):
    slug, email = f"zz-tokui-{uid}", f"zz.ui{uid}@exemplo.com"
    cria_time(admin, slug)
    assert admin.add_user(email, SENHA, f"/{slug}").ok
    painel = Api(email, SENHA)
    login_token(page, painel.token)

    # o item aparece no menu para contas de e-mail e leva à tela
    item = page.locator("nav [data-sp-api]")
    expect(item).to_be_visible(timeout=15000)
    expect(item).to_contain_text("Tokens de API")
    item.click()
    page.wait_for_url("**/admin/times/api.html")
    expect(page.locator("#content .empty")).to_be_visible(timeout=15000)
    expect(page.locator("#uso")).to_be_visible()
    assert "/admin/entra/api/sessao" in page.inner_text("#exemplo")
    prompt = page.inner_text("#prompt")
    assert "/admin/entra/api/sessao" in prompt and "sp_COLE_AQUI_O_TOKEN" in prompt and "Pergunte o nome da pasta" in prompt
    assert BASE in prompt   # endereço do ambiente já preenchido

    # cria: o token aparece uma vez, no formato sp_…
    page.click("#btn-new")
    page.fill("#form-new [name=nome]", "Job de vendas")
    page.select_option("#form-new [name=dias]", "30")
    page.click("#form-new button[value=ok]")
    expect(page.locator("#dlg-token[open] #token-valor")).to_have_text(__import__("re").compile(r"^sp_[A-Za-z0-9_-]{43}$"), timeout=15000)
    valor = page.inner_text("#token-valor")
    assert sessao(valor).status_code == 200            # funciona de verdade
    page.click("#dlg-token button[value=ok]")
    expect(page.locator("#token-valor")).to_have_text("")     # não fica no DOM depois de fechar

    # lista: nome, papel, validade; o token em claro não aparece
    linha = page.locator("#content tbody tr")
    expect(linha).to_have_count(1)
    expect(linha).to_contain_text("Job de vendas")
    expect(linha).to_contain_text("Editor")
    expect(linha).to_contain_text("nunca usado")
    assert valor not in page.content()

    # revoga pela tela: a troca passa a falhar
    page.once("dialog", lambda d: d.accept())
    page.click("[data-revogar]")
    expect(page.locator("#content .empty")).to_be_visible(timeout=15000)
    assert sessao(valor).status_code == 401
    assert page.errors == []


def test_menu_de_tokens_nao_aparece_para_admin_local(page, admin):
    login_token(page, admin.token)
    page.wait_for_timeout(1500)
    expect(page.locator("nav [data-sp-times]")).to_be_visible(timeout=15000)   # o menu carregou
    assert page.locator("nav [data-sp-api]").count() == 0
    page.goto(f"{BASE}/admin/times/api.html")
    expect(page.locator("#content .notice")).to_contain_text("usuário e senha", timeout=15000)
    assert page.locator("#btn-new:visible").count() == 0


SCRIPT = Path(__file__).resolve().parent.parent / "conf" / "guia" / "publicar.py"


def roda_publicar(token, *args, html=HTML):
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as f:
        f.write(html)
    try:
        return subprocess.run([sys.executable, str(SCRIPT), "--url", BASE, *args, f.name], capture_output=True, text=True,
                              env={**os.environ, "PAGES_TOKEN": token}, timeout=60)
    finally:
        os.unlink(f.name)


def test_script_publicar_py_do_guia(admin, uid):
    slug, email = f"zz-pub-{uid}", f"zz.pub{uid}@exemplo.com"
    cria_time(admin, slug)
    assert admin.add_user(email, SENHA, f"/{slug}").ok
    tok = cria_token(Api(email, SENHA))["token"]

    r = roda_publicar(tok, "--pasta", "relatorio")
    assert r.returncode == 0, r.stderr
    assert f"/{slug}/relatorio/" in r.stdout
    assert requests.get(f"{BASE}/{slug}/relatorio/", timeout=10).text == HTML
    # sem --atualizar, a segunda vez é recusada com a dica
    r = roda_publicar(tok, "--pasta", "relatorio", html="<h1>v2</h1>")
    assert r.returncode == 1 and "--atualizar" in r.stderr
    # --atualizar substitui (a versão anterior vai para a lixeira)
    r = roda_publicar(tok, "--pasta", "relatorio", "--atualizar", html="<h1>v2</h1>")
    assert r.returncode == 0, r.stderr
    assert requests.get(f"{BASE}/{slug}/relatorio/", timeout=10).text == "<h1>v2</h1>"
    assert f"/{slug}/relatorio/index.html" in admin.req("GET", "/raw/_lixeira/.registro").text
    # erros claros
    assert "token inválido" in roda_publicar("sp_" + "a" * 43, "--pasta", "x").stderr
    assert "minúsculas" in roda_publicar(tok, "--pasta", "Nome Ruim").stderr
    assert "PAGES_TOKEN" in roda_publicar("lixo", "--pasta", "x").stderr


def test_script_publicar_py_leitor_e_admin(admin, uid):
    slug, leitor, adm = f"zz-publ-{uid}", f"zz.publeitor{uid}@exemplo.com", f"zz.pubadmin{uid}@exemplo.com"
    cria_time(admin, slug)
    assert admin.add_user(leitor, SENHA, f"/{slug}", leitor=True).ok
    assert admin.add_user(adm, SENHA, "/", admin=True).ok
    r = roda_publicar(cria_token(Api(leitor, SENHA))["token"], "--pasta", "x")
    assert r.returncode == 1 and "Leitor" in r.stderr
    tok = cria_token(Api(adm, SENHA))["token"]
    assert "--time" in roda_publicar(tok, "--pasta", "x").stderr          # admin precisa dizer o time
    r = roda_publicar(tok, "--pasta", "do-admin", "--time", slug)
    assert r.returncode == 0, r.stderr
    assert requests.get(f"{BASE}/{slug}/do-admin/", timeout=10).status_code == 200

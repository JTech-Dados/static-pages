"""Times restritos: acesso só para e-mails autorizados (login Microsoft), por time, na navegação.

Precisa do Entra ligado com chaves de teste (como test_entra.py). Entrar usa ID tokens assinados por uma chave de teste.
O cookie é Secure; como os testes rodam em http, ele é enviado à mão no cabeçalho Cookie.
"""
import json
import subprocess

import pytest
import requests
from playwright.sync_api import expect

from conftest import BASE, BASE_PATH, CONTAINER, Api, in_container, login_token
from test_entra import idp  # noqa: F401  (fixture que assina ID tokens de teste)

ENTRA = f"{BASE}/admin/entra"
SENHA = "SenhaTeste123456"


def cria_time(admin, slug, nome=None):
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": nome or slug}))
    admin.write(f"/{slug}/index.html", "<h1>time</h1>")
    admin.write(f"/{slug}/segredo/index.html", "<h1>conteudo restrito do time</h1>")
    admin.write(f"/{slug}/segredo/estilo.css", "body{color:red}")
    admin.write(f"/{slug}/segredo/dados.json", '{"x":1}')
    admin.write(f"/{slug}/segredo/meta.json", '{"titulo":"Titulo secreto"}')


def restringe(admin, slug, emails, ativo=True):
    r = requests.put(f"{ENTRA}/site/acesso", json={"time": slug, "ativo": ativo, "emails": emails}, headers=admin.h, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def entra(idp, email, slug):  # noqa: F811
    r = requests.post(f"{ENTRA}/site/entrar", json={"idToken": idp(email), "site": slug}, timeout=10)
    return r


def cookie(r):
    return r.headers["Set-Cookie"].split(";")[0]


def get(path, ck=None):
    return requests.get(f"{BASE}{path}", headers={"Cookie": ck} if ck else {}, timeout=10, allow_redirects=False)


def test_time_restrito_so_abre_com_acesso(admin, uid, idp):  # noqa: F811
    slug = f"zz-rest-{uid}"
    cria_time(admin, slug, "Restrito")
    pessoa = f"zz.convidada{uid}@exemplo.com"

    # antes: público
    assert get(f"/{slug}/segredo/").status_code == 200
    restringe(admin, slug, [pessoa.upper()])      # caixa alta na lista

    # sem sessão: página de entrada (401), sem vazar nada, sem cache e sem enumeração
    for caminho in (f"/{slug}/", f"/{slug}/segredo/", f"/{slug}/segredo/estilo.css", f"/{slug}/segredo/dados.json", f"/{slug}/nao-existe/", f"/{slug}/nao-existe.css"):
        r = get(caminho)
        assert r.status_code == 401, (caminho, r.status_code)
        assert "Conteúdo restrito" in r.text and "conteudo restrito do time" not in r.text
        assert "no-store" in r.headers["Cache-Control"] and "Cookie" in r.headers["Vary"]
        assert "frame-ancestors 'none'" in r.headers["Content-Security-Policy"]
        assert r.headers["Referrer-Policy"] == "no-referrer"
        assert f"__TIME__" not in r.text and "__SP_BASE__" not in r.text and slug in r.text
    # a lista de pastas e o meta.json do time não vazam (401 em JSON com CORS, para a home ler o status)
    for caminho in (f"/_pastas/{slug}/", f"/_pastas/{slug}/segredo/", f"/{slug}/segredo/meta.json"):
        r = get(caminho)
        assert r.status_code == 401 and r.json() == {"erro": "restrito"}, (caminho, r.status_code, r.text[:80])
        assert r.headers["Access-Control-Allow-Origin"] == "*"
    assert "Titulo secreto" not in get(f"/{slug}/segredo/meta.json").text
    # continuam públicos: o nome do time e a lista da raiz (decisão do dono)
    assert get(f"/{slug}/.time.json").json()["nome"] == "Restrito"
    assert slug in get("/_pastas/").text
    assert get("/").status_code == 200

    # entra pela lista: cookie HttpOnly, Secure, Lax, restrito ao time
    r = entra(idp, pessoa, slug)
    assert r.status_code == 200
    attrs = r.headers["Set-Cookie"]
    assert "HttpOnly" in attrs and "Secure" in attrs and "SameSite=Lax" in attrs and f"Path={BASE_PATH}/{slug}/" in attrs
    ck = cookie(r)
    ok = get(f"/{slug}/segredo/", ck)
    assert ok.status_code == 200 and "conteudo restrito do time" in ok.text
    assert "no-store" in ok.headers["Cache-Control"] and "private" in ok.headers["Cache-Control"]
    assert ok.headers["Referrer-Policy"] == "no-referrer" and "frame-ancestors 'none'" in ok.headers["Content-Security-Policy"]
    assert get(f"/{slug}/segredo/estilo.css", ck).status_code == 200
    assert "public" not in get(f"/{slug}/segredo/estilo.css", ck).headers["Cache-Control"]
    assert get(f"/{slug}/nao-existe/", ck).status_code == 404       # com acesso, 404 normal
    # cookie adulterado: volta à entrada
    assert get(f"/{slug}/", ck[:-3] + "AAA").status_code == 401

    # fora da lista: 403 no login e nada de cookie
    estranha = entra(idp, f"zz.estranha{uid}@exemplo.com", slug)
    assert estranha.status_code == 403 and "Set-Cookie" not in estranha.headers

    # remover o e-mail da lista revoga na hora (o cookie continua válido, a lista é relida)
    restringe(admin, slug, [])
    r = get(f"/{slug}/segredo/", ck)
    assert r.status_code == 403 and "Conteúdo restrito" in r.text
    # desligar: volta a ser público
    restringe(admin, slug, [], ativo=False)
    assert get(f"/{slug}/segredo/").status_code == 200
    assert get(f"/{slug}/segredo/meta.json").status_code == 200


def test_membro_do_time_e_admin_entram_sem_estar_na_lista(admin, uid, idp):  # noqa: F811
    slug, outro = f"zz-rest2-{uid}", f"zz-rest3-{uid}"
    cria_time(admin, slug)
    cria_time(admin, outro)
    membro, vizinho, adm = f"zz.membro{uid}@exemplo.com", f"zz.vizinho{uid}@exemplo.com", f"zz.adm{uid}@exemplo.com"
    assert admin.add_user(membro, SENHA, f"/{slug}").ok
    assert admin.add_user(vizinho, SENHA, f"/{outro}").ok
    assert admin.add_user(adm, SENHA, "/", admin=True).ok
    restringe(admin, slug, [])          # lista vazia: só time e admin
    restringe(admin, outro, [])

    ck_m = cookie(entra(idp, membro, slug))
    assert get(f"/{slug}/segredo/", ck_m).status_code == 200
    assert entra(idp, adm, slug).status_code == 200
    assert entra(idp, vizinho, slug).status_code == 403           # membro de OUTRO time não entra
    # o cookie de um time não abre o outro
    assert get(f"/{outro}/segredo/", ck_m.replace(f"sp_s_{slug}", f"sp_s_{outro}")).status_code == 401
    assert get(f"/{outro}/segredo/", ck_m).status_code == 401


def test_visitas_de_time_restrito_nao_aparecem(admin, uid, idp):  # noqa: F811
    slug, pessoa = f"zz-rest4-{uid}", f"zz.visita{uid}@exemplo.com"
    cria_time(admin, slug)
    restringe(admin, slug, [pessoa])
    ck = cookie(entra(idp, pessoa, slug))
    assert get(f"/{slug}/segredo/", ck).status_code == 200
    in_container("sp-visitas")
    visitas = requests.get(f"{BASE}/_visitas.json", timeout=10).json()["paginas"]
    assert not any(k.startswith(f"/{slug}/") for k in visitas), visitas
    restringe(admin, slug, [pessoa], ativo=False)
    assert get(f"/{slug}/segredo/").status_code == 200       # público de novo (e conta visita)
    in_container("sp-visitas")
    assert any(k.startswith(f"/{slug}/") for k in requests.get(f"{BASE}/_visitas.json", timeout=10).json()["paginas"])


def test_quem_edita_a_lista(admin, uid, idp):  # noqa: F811
    slug = f"zz-rest5-{uid}"
    cria_time(admin, slug)
    editor, leitor, de_fora = f"zz.edit{uid}@exemplo.com", f"zz.leit{uid}@exemplo.com", f"zz.fora{uid}@exemplo.com"
    assert admin.add_user(editor, SENHA, f"/{slug}").ok
    assert admin.add_user(leitor, SENHA, f"/{slug}", leitor=True).ok
    assert admin.add_user(de_fora, SENHA, "/x-nao-existe", ).ok
    corpo = {"time": slug, "ativo": True, "emails": ["a@exemplo.com"]}
    put = lambda api, c=corpo: requests.put(f"{ENTRA}/site/acesso", json=c, headers=api.h, timeout=10)
    assert put(Api(leitor, SENHA)).status_code == 403
    assert put(Api(de_fora, SENHA)).status_code == 403
    assert put(Api(editor, SENHA)).status_code == 200
    assert requests.get(f"{ENTRA}/site/acesso?time={slug}", headers=Api(editor, SENHA).h, timeout=10).json()["emails"] == ["a@exemplo.com"]
    assert put(admin, {**corpo, "time": "../etc"}).status_code == 400
    assert requests.put(f"{ENTRA}/site/acesso", json=corpo, timeout=10).status_code == 401
    # a decisão do gate não existe por fora
    assert requests.get(f"{ENTRA}/site/auth", headers={"X-Time": slug}, timeout=10).status_code == 404


def test_falha_fechado_com_sp_auth_parado(admin, uid, idp):  # noqa: F811
    slug, pessoa = f"zz-rest6-{uid}", f"zz.parado{uid}@exemplo.com"
    cria_time(admin, slug)
    restringe(admin, slug, [pessoa])
    ck = cookie(entra(idp, pessoa, slug))
    assert get(f"/{slug}/segredo/", ck).status_code == 200
    # congela o node (o laço do entrypoint reinicia em 2 s se ele morrer; kill -STOP não)
    subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", "pkill -STOP -f sp-auth.js"], check=True)
    try:
        r = get(f"/{slug}/segredo/", ck)
        assert r.status_code == 500 and "conteudo restrito do time" not in r.text
        assert get(f"/{slug}/index.html").status_code == 500           # o próprio time restrito, sem cookie
        assert get("/").status_code == 200                              # o resto do site não depende do sp-auth
    finally:
        subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", "pkill -CONT -f sp-auth.js"], check=True)
    assert get(f"/{slug}/segredo/", ck).status_code == 200


def test_outro_time_sandboxed_nao_le_o_restrito(admin, uid, idp, browser):  # noqa: F811
    """Um HTML de outro time (origem opaca) não consegue ler o restrito, nem com fetch e credenciais."""
    slug, pessoa, atacante = f"zz-rest7-{uid}", f"zz.vitima{uid}@exemplo.com", f"zz-ataque-{uid}"
    cria_time(admin, slug)
    restringe(admin, slug, [pessoa])
    ck = cookie(entra(idp, pessoa, slug))
    admin.mkdir(f"/{atacante}")
    admin.write(f"/{atacante}/.time.json", json.dumps({"nome": "Atacante"}))
    alvo = f"{BASE}/{slug}/segredo/"
    admin.write(f"/{atacante}/index.html", f"""<!doctype html><title>carregando</title><script>
      fetch("{alvo}", {{credentials: "include"}}).then(r => r.text().then(t => document.title = "LIDO:" + r.status + ":" + t.slice(0, 40)))
        .catch(e => document.title = "BLOQUEADO");
    </script>""")
    nome, valor = ck.split("=", 1)
    ctx = browser.new_context()
    ctx.add_cookies([{"name": nome, "value": valor, "url": f"{BASE}/{slug}/", "httpOnly": True}])
    pg = ctx.new_page()
    pg.goto(f"{BASE}/{atacante}/")
    pg.wait_for_function("document.title !== 'carregando'", timeout=15000)
    assert pg.title() == "BLOQUEADO" or "conteudo restrito" not in pg.title(), pg.title()
    ctx.close()


def test_pagina_de_entrada_no_navegador(admin, uid, page):
    slug = f"zz-rest8-{uid}"
    cria_time(admin, slug, "Time Secreto")
    restringe(admin, slug, [])
    page.goto(f"{BASE}/{slug}/segredo/")
    expect(page.locator("h1")).to_have_text("Conteúdo restrito")
    expect(page.locator("#time-nome")).to_have_text("Time Secreto", timeout=15000)
    expect(page.locator("#entrar")).to_be_enabled(timeout=15000)
    assert page.locator("a.volta").get_attribute("href") == f"{BASE_PATH}/"
    assert [e for e in page.errors if "401" not in e] == []   # o 401 do próprio documento é esperado


def test_home_mostra_o_cadeado_sem_revelar_o_conteudo(admin, uid, page):
    publico, restrito = f"zz-home-{uid}", f"zz-homer-{uid}"
    cria_time(admin, publico, "Time Publico")
    cria_time(admin, restrito, "Time Fechado")
    admin.write(f"/{restrito}/segredo/meta.json", '{"titulo":"Titulo secreto","descricao":"descricao secreta"}')
    restringe(admin, restrito, [])
    page.goto(f"{BASE}/")
    secao = page.locator("section.pool").filter(has=page.locator("h2", has_text="Time Fechado"))
    expect(secao).to_be_visible(timeout=15000)
    card = secao.locator("article.card.restrito")
    expect(card).to_have_count(1)
    expect(card).to_contain_text("Acesso restrito")
    expect(secao.locator(".pool-count")).to_have_text("restrito")
    assert card.locator("a").get_attribute("href") == f"{BASE_PATH}/{restrito}/"
    corpo = secao.inner_html()          # só o cartão do time restrito (o time público tem o próprio meta.json)
    assert "Titulo secreto" not in corpo and "descricao secreta" not in corpo and "segredo" not in corpo
    # o time público segue normal, com as páginas contadas
    expect(page.locator("section.pool").filter(has=page.locator("h2", has_text="Time Publico"))).to_contain_text("página")
    # clicar leva à página de entrada (401)
    card.locator("a").click()
    expect(page.locator("h1")).to_have_text("Conteúdo restrito")
    assert [e for e in page.errors if "401" not in e] == []



def test_tela_acesso_restrito_do_editor_e_do_admin(admin, uid, page, browser):
    slug = f"zz-tela-{uid}"
    cria_time(admin, slug, "Time da Tela")
    editor, leitor = f"zz.editui{uid}@exemplo.com", f"zz.leitui{uid}@exemplo.com"
    assert admin.add_user(editor, SENHA, f"/{slug}").ok
    assert admin.add_user(leitor, SENHA, f"/{slug}", leitor=True).ok

    # editor: o item aparece no menu; salva a lista e liga
    login_token(page, Api(editor, SENHA).token)
    item = page.locator("nav [data-sp-restrito]")
    expect(item).to_be_visible(timeout=15000)
    item.click()
    page.wait_for_url("**/admin/times/restrito.html")
    expect(page.locator("#painel")).to_be_visible(timeout=15000)
    expect(page.locator("#alvo-texto")).to_contain_text("Time da Tela")
    assert page.locator("#linha-time:visible").count() == 0            # editor não escolhe time
    page.fill("#emails", f"Convidada{uid}@exemplo.com\nsegunda{uid}@exemplo.com")
    page.check("#ativo")
    page.click("#salvar")
    expect(page.locator("#toast")).to_contain_text("salvo", timeout=15000)
    assert get(f"/{slug}/").status_code == 401                          # ligou de verdade
    page.reload()
    expect(page.locator("#emails")).to_have_value(f"convidada{uid}@exemplo.com\nsegunda{uid}@exemplo.com", timeout=15000)
    expect(page.locator("#ativo")).to_be_checked()
    # e-mail inválido: mensagem e nada muda
    page.fill("#emails", "sem-arroba")
    page.click("#salvar")
    expect(page.locator("#toast")).to_contain_text("inválido", timeout=15000)

    # leitor não vê o item e a tela avisa
    ctx = browser.new_context()
    lp = ctx.new_page()
    login_token(lp, Api(leitor, SENHA).token)
    lp.wait_for_timeout(1500)
    assert lp.locator("nav [data-sp-restrito]").count() == 0
    lp.goto(f"{BASE}/admin/times/restrito.html")
    expect(lp.locator("#aviso")).to_contain_text("editores", timeout=15000)
    ctx.close()

    # admin: escolhe o time (e o card do time abre a tela já nele)
    ap = browser.new_page()
    login_token(ap, admin.token)
    ap.goto(f"{BASE}/admin/times")
    card = ap.locator("article.card").filter(has=ap.locator("h3", has_text="Time da Tela"))
    expect(card).to_be_visible(timeout=20000)
    card.get_by_role("link", name="Acesso restrito").click()
    ap.wait_for_url(f"**/restrito.html?time={slug}")
    expect(ap.locator("#time")).to_have_value(slug, timeout=15000)
    expect(ap.locator("#ativo")).to_be_checked()
    ap.close()


def test_pagina_restrita_com_espaco_no_nome_e_time_publico(admin, uid, idp):  # noqa: F811
    """Restrição por página (pasta do 1º nível): o time e as outras páginas seguem públicos; nome com espaço e acento entra."""
    slug = f"zz-pag-{uid}"
    pg = "Teste Cockpit Cirúrgico"
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": "Time Pag"}))
    admin.write(f"/{slug}/index.html", "<h1>time</h1>")
    admin.mkdir(f"/{slug}/{pg}")
    admin.write(f"/{slug}/{pg}/index.html", "<h1>cockpit restrito</h1>")
    admin.write(f"/{slug}/{pg}/dados.json", '{"x":1}')
    admin.write(f"/{slug}/outra/index.html", "<h1>outra publica</h1>")
    pessoa = f"zz.convidada{uid}@exemplo.com"

    r = requests.put(f"{ENTRA}/site/acesso", json={"time": slug, "pagina": pg, "ativo": True, "emails": [pessoa]}, headers=admin.h, timeout=10)
    assert r.status_code == 200 and r.json()["paginas"] == [pg], r.text

    # a página pede login; o time e a outra página seguem públicos
    caminho = f"/{slug}/{pg}/"
    sem = get(caminho)
    assert sem.status_code == 401 and "Conteúdo restrito" in sem.text and "cockpit restrito" not in sem.text
    assert get(f"{caminho}dados.json").status_code == 401
    assert get(f"/{slug}/").status_code == 200 and get(f"/{slug}/outra/").status_code == 200
    # a lista de pastas do time segue pública (nomes das páginas), mas a da página restrita e o meta.json não
    assert pg in get(f"/_pastas/{slug}/").text
    for p in (f"/_pastas/{slug}/{pg}/", f"/{slug}/{pg}/meta.json"):
        assert get(p).status_code == 401 and get(p).json() == {"erro": "restrito"}, p

    # entra pela lista (o navegador manda a página; espaço e acento passam pelo gate)
    e = requests.post(f"{ENTRA}/site/entrar", json={"idToken": idp(pessoa), "site": slug, "pagina": pg}, timeout=10)
    assert e.status_code == 200, e.text
    ck = cookie(e)
    ok = get(caminho, ck)
    assert ok.status_code == 200 and "cockpit restrito" in ok.text
    assert get(f"{caminho}dados.json", ck).status_code == 200
    assert get(caminho, ck[:-3] + "AAA").status_code == 401
    # quem não está na lista (e não é do time) não entra
    n = requests.post(f"{ENTRA}/site/entrar", json={"idToken": idp(f"zz.estranha{uid}@exemplo.com"), "site": slug, "pagina": pg}, timeout=10)
    assert n.status_code == 403 and "Set-Cookie" not in n.headers

    # desligar devolve a página ao público
    requests.put(f"{ENTRA}/site/acesso", json={"time": slug, "pagina": pg, "ativo": False, "emails": [pessoa]}, headers=admin.h, timeout=10)
    assert get(caminho).status_code == 200

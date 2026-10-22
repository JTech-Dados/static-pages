"""Fluxos do painel: times, membros, colunas, lixeira, atividade, home e visitas."""
import json

import requests
from playwright.sync_api import expect

from conftest import ADMIN_PASS, ADMIN_USER, BASE, Api, in_container, login, login_token


def card_do_time(pg, nome):
    return pg.locator("article.card").filter(has=pg.locator("h3", has_text=nome))


def test_time_completo_pela_tela(page, browser, admin, uid):
    slug, nome, pessoa = f"zz-time-{uid}", f"Time Teste {uid}", f"zz.pessoa{uid}"
    login(page, ADMIN_USER, ADMIN_PASS)

    # a aba mostra só o nome do produto, em qualquer tela do painel
    expect(page).to_have_title("Static Pages")
    # barra superior: quem está logado e o papel
    expect(page.locator("[data-sp-chip] .sp-chip-user")).to_have_text(ADMIN_USER, timeout=15000)
    expect(page.locator("[data-sp-chip] .sp-chip-role")).to_have_text("Admin")
    expect(page.locator("[data-sp-chip] .sp-chip-team")).to_have_text("Todos os times")

    # item "Times" no menu do painel
    expect(page.locator("nav [data-sp-times]")).to_be_visible()
    page.locator("nav [data-sp-times]").click()
    page.wait_for_url("**/admin/times")

    # cria o time (com página modelo)
    page.click("#btn-new")
    page.fill("#form-team [name=nome]", nome)
    page.fill("#form-team [name=slug]", slug)
    page.fill("#form-team [name=cota]", "1")
    page.click("#form-team button[value=ok]")
    card = card_do_time(page, nome)
    expect(card).to_be_visible(timeout=20000)
    expect(card.locator(".quota")).to_be_visible()
    assert requests.get(f"{BASE}/{slug}/", timeout=10).status_code == 200  # modelo criado

    # adiciona pessoa e pega a senha gerada
    card.get_by_role("button", name="+ Adicionar pessoa").click()
    page.fill("#form-member [name=username]", pessoa)
    senha = page.input_value("#form-member [name=password]")
    page.click("#form-member button[value=ok]")
    expect(page.locator("#dlg-secret")).to_be_visible(timeout=15000)
    assert senha in page.inner_text("#secret")
    page.click("#dlg-secret button[value=ok]")
    # as pessoas ficam no diálogo; o card mostra só o resumo (clicar no card ou em "Pessoas" abre)
    expect(card.locator(".stat", has_text="pessoa")).to_contain_text("1", timeout=15000)
    expect(card.locator(".members")).to_have_count(0)
    card.locator(".team-title h3").click()
    expect(page.locator("#dlg-people[open] .members li", has_text=pessoa)).to_be_visible(timeout=15000)
    page.click("#people-close")
    expect(page.locator("#dlg-people[open]")).to_have_count(0)

    # membro: só a pasta do time, sem item Times, sem colunas, sem acesso à tela
    membro = Api(pessoa, senha)
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    m = ctx.new_page()
    login_token(m, membro.token)
    m.wait_for_timeout(800)
    expect(m.locator("[data-sp-chip] .sp-chip-user")).to_have_text(pessoa, timeout=15000)
    expect(m.locator("[data-sp-chip] .sp-chip-team")).to_have_text(nome)
    expect(m.locator("[data-sp-chip] .sp-chip-role")).to_have_text("Editor")
    assert m.locator("[data-sp-pending]:visible").count() == 0   # aviso de pedidos é só do admin
    # barra de espaço do menu: espaço do time (cota 1 MB do teste), não o disco da máquina
    usage = membro.req("GET", "/usage/").json()
    assert usage["total"] == 1048576 and 0 < usage["used"] < 1048576, usage
    expect(m.locator("nav .credits, nav .progress-bar + *").first).to_be_visible()
    assert m.locator("nav [data-sp-times]").count() == 0
    assert m.locator(".sp-team, .sp-who").count() == 0
    m.goto(f"{BASE}/admin/times")
    expect(m.locator("#app")).to_contain_text("Só administradores")
    ctx.close()

    # a pasta do time não lista arquivos de outros times para o membro
    nomes = [i["name"] for i in membro.req("GET", "/resources/").json().get("items", [])]
    assert "index.html" in nomes and not any(n.startswith("zz-") for n in nomes)

    assert page.errors == []


def test_autoria_e_colunas(page, admin, uid):
    pasta, pessoa, senha = f"zz-aut-{uid}", f"zz.autor{uid}", "SenhaTeste123456"
    admin.write(f"/{pasta}/.time.json", json.dumps({"nome": "Autoria"}))
    admin.add_user(pessoa, senha, f"/{pasta}")
    Api(pessoa, senha).write("/relatorio.html", "<h1>oi</h1>")

    login_token(page, admin.token)
    page.goto(f"{BASE}/admin/files/{pasta}/")
    row = page.locator("#listing .item[aria-label='relatorio.html']")
    expect(row.locator(".sp-who")).to_have_text(pessoa, timeout=10000)
    expect(row.locator(".sp-team")).to_have_text("Autoria")
    assert page.errors == []


def test_lixeira_restaurar_e_atividade(page, admin, uid):
    pasta = f"zz-lix-{uid}"
    admin.write(f"/{pasta}/sub/b.txt", "conteudo B")
    assert admin.delete(f"/{pasta}/sub/").status_code in (200, 204)
    assert requests.get(f"{BASE}/{pasta}/sub/b.txt", timeout=10).status_code == 404

    login_token(page, admin.token)
    page.goto(f"{BASE}/admin/times#lixeira")
    linha = page.locator("#trash tr").filter(has=page.locator("td.path", has_text=f"/{pasta}/sub"))
    expect(linha).to_have_count(1, timeout=15000)
    linha.get_by_role("button", name="Restaurar").click()
    expect(page.locator("#toast")).to_contain_text("restaurado", timeout=15000)
    expect(linha).to_have_count(0, timeout=15000)
    assert requests.get(f"{BASE}/{pasta}/sub/b.txt", timeout=10).text == "conteudo B"

    page.click("[data-view-tab=atividade]")
    expect(page.locator("#activity")).to_contain_text("restaurou", timeout=15000)
    expect(page.locator("#btn-new")).to_be_hidden()
    assert page.errors == []


def test_home_agrupa_por_time_e_conta_visitas(page, admin, uid):
    slug, nome = f"zz-home-{uid}", f"Time Home {uid}"
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": nome}))
    admin.write(f"/{slug}/relatorio/index.html", "<h1>r</h1>")
    admin.write(f"/{slug}/relatorio/detalhe/index.html", "<h1>d</h1>")
    for _ in range(3):
        requests.get(f"{BASE}/{slug}/relatorio/", timeout=10)
    in_container("sp-visitas")

    page.goto(f"{BASE}/", wait_until="networkidle")
    secao = page.locator(".pool").filter(has=page.locator(".pool-head h2", has_text=nome))
    expect(secao).to_be_visible(timeout=10000)
    card = secao.locator(".card", has_text="Relatorio")
    expect(card.locator(".subs a", has_text="Detalhe")).to_be_visible()
    expect(card.locator(".views")).to_contain_text("3 visitas")

    page.fill("#search", "detalhe")
    expect(page.locator("#count")).to_contain_text("de")
    assert page.errors == []


def test_aba_usuarios_muda_papel_e_time(page, admin, uid):
    slug, nome, pessoa = f"zz-usr-{uid}", f"Time Usuarios {uid}", f"zz.usr{uid}@teste.com"
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": nome}))
    assert admin.add_user(pessoa, "Senha-Inicial-123456", f"/{slug}").ok

    login_token(page, admin.token)
    page.goto(f"{BASE}/admin/times#usuarios")
    linha = page.locator("#users tr", has_text=pessoa)
    expect(linha).to_be_visible(timeout=20000)
    assert page.locator("#users tr", has_text="sp-svc").count() == 0   # conta técnica não aparece

    # a própria conta (admin) não muda o próprio papel nem se remove
    propria = page.locator("#users tr", has_text=ADMIN_USER).first
    expect(propria.locator("select").first).to_be_disabled()

    def usuario():
        return next(u for u in admin.users() if u["username"] == pessoa)

    # editor -> admin (confirma o aviso): vê tudo, escopo "/"
    linha.locator("select").first.select_option("admin")
    expect(page.locator("#users tr", has_text=pessoa).locator(".faint")).to_have_text("Todos os times", timeout=20000)
    u = usuario()
    assert u["perm"]["admin"] and u["scope"] == "/" and not u["hideDotfiles"]

    # admin -> leitor: pede o time e prende a pessoa nele, sem poder editar
    page.locator("#users tr", has_text=pessoa).locator("select").first.select_option("leitor")
    page.select_option("#form-role [name=team]", slug)
    page.click("#form-role button[value=ok]")
    expect(page.locator("#users tr", has_text=pessoa).locator("select").nth(1)).to_contain_text(nome, timeout=20000)
    u = usuario()
    assert not u["perm"]["admin"] and not u["perm"]["modify"] and u["perm"]["download"]
    assert u["scope"] == f"/{slug}" and u["hideDotfiles"]
    assert page.errors == []


def test_cota_do_time_bloqueia_upload_e_registra_acoes(page, admin, uid):
    slug, nome, pessoa, senha = f"zz-cot-{uid}", f"Time Cota {uid}", f"zz.cota{uid}", "SenhaTeste123456"
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": nome, "cota_mb": 1}))
    admin.write(f"/{slug}/index.html", "x" * 600_000)   # ~0,6 MB dos 1 MB
    assert admin.add_user(pessoa, senha, f"/{slug}").ok
    membro = Api(pessoa, senha)

    # cabe: sobe; estoura: 413 com a mensagem em português; o admin não tem limite
    assert membro.req("POST", "/resources/pequeno.txt?override=true", data=b"x" * 10_000).status_code == 200
    r = membro.req("POST", "/resources/grande.bin?override=true", data=b"x" * 600_000)
    assert r.status_code == 413 and "cota" in r.text and "espaço" in r.text, (r.status_code, r.text)
    # a interface envia pelo tus: cria sem tamanho e manda os bytes no PATCH (é aí que a cota vale)
    assert membro.req("POST", "/tus/tus.bin?override=false", headers={"Tus-Resumable": "1.0.0"}).status_code == 201
    r = membro.req("PATCH", "/tus/tus.bin?override=false", data=b"x" * 600_000,
                   headers={"Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
    assert r.status_code == 413 and "cota" in r.text, (r.status_code, r.text)
    membro.req("DELETE", "/resources/tus.bin")
    assert admin.req("POST", f"/resources/{slug}/grande.bin?override=true", data=b"x" * 600_000).status_code == 200
    # leitura e remoção continuam livres para quem estourou
    assert membro.req("GET", "/resources/").status_code == 200
    assert membro.req("DELETE", "/resources/grande.bin").status_code == 204
    assert admin.req("GET", f"/resources/{slug}/").status_code == 200

    # o histórico (aba Atividade) registra o envio recusado
    log = admin.req("GET", "/../_auditoria") if False else requests.get(f"{BASE}/admin/_auditoria", headers=admin.h, timeout=10)
    assert "acesso_cota" in log.text and pessoa in log.text

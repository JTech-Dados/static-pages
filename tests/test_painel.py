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
    expect(card.locator(".members li", has_text=pessoa)).to_be_visible(timeout=15000)

    # membro: só a pasta do time, sem item Times, sem colunas, sem acesso à tela
    membro = Api(pessoa, senha)
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    m = ctx.new_page()
    login_token(m, membro.token)
    m.wait_for_timeout(800)
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

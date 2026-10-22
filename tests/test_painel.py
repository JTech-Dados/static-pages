"""Fluxos do painel: times, membros, colunas, lixeira, atividade, home e visitas."""
import json

import requests
from playwright.sync_api import expect

from conftest import ADMIN_PASS, ADMIN_USER, BASE, BASE_PATH, Api, in_container, login, login_token

ENTRA = f"{BASE}/admin/entra"


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
    assert m.locator(".sp-team").count() == 0   # a coluna Time é só do admin; "Alterado por" todos veem
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


def test_leitor_so_consulta_e_baixa(page, admin, uid):
    slug, nome, pessoa, senha = f"zz-leit-{uid}", f"Time Leitor {uid}", f"zz.leitor{uid}", "SenhaTeste123456"
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": nome}))
    admin.write(f"/{slug}/index.html", "<h1>time</h1>")
    admin.write(f"/{slug}/fora.txt", "so o admin mexe")
    assert admin.add_user(pessoa, senha, f"/{slug}", leitor=True).ok
    leitor = Api(pessoa, senha)

    # consulta e baixa
    nomes = [i["name"] for i in leitor.req("GET", "/resources/").json()["items"]]
    assert "index.html" in nomes and "fora.txt" in nomes
    assert leitor.req("GET", "/raw/fora.txt").text == "so o admin mexe"
    # nada de escrever, renomear nem apagar (o File Browser responde 403)
    assert leitor.req("POST", "/resources/novo.txt?override=true", data=b"x").status_code == 403
    assert leitor.req("PUT", "/resources/fora.txt", data=b"alterado").status_code == 403
    assert leitor.req("PATCH", "/resources/fora.txt?action=rename&destination=/outro.txt&override=false").status_code == 403
    assert leitor.req("DELETE", "/resources/fora.txt").status_code == 403
    assert leitor.req("POST", "/resources/pasta-nova/").status_code == 403
    # e o upload pelo tus (o que a interface usa) também
    assert leitor.req("POST", "/tus/tus.bin?override=false", headers={"Tus-Resumable": "1.0.0"}).status_code == 403
    # nada mudou
    assert admin.req("GET", f"/raw/{slug}/fora.txt").text == "so o admin mexe"
    nomes = [i["name"] for i in admin.req("GET", f"/resources/{slug}/").json()["items"]]
    assert "novo.txt" not in nomes and "pasta-nova" not in nomes and "outro.txt" not in nomes and "tus.bin" not in nomes
    # continua preso à pasta do time e sem acesso a admin
    assert leitor.req("GET", "/users").status_code == 403
    assert leitor.req("GET", f"/resources/{slug}/").status_code in (403, 404)

    # a barra superior mostra o papel
    login_token(page, leitor.token)
    expect(page.locator("[data-sp-chip] .sp-chip-role")).to_have_text("Leitor", timeout=15000)
    expect(page.locator("[data-sp-chip] .sp-chip-team")).to_have_text(nome)
    assert page.errors == []


def test_login_tem_caminho_de_volta_para_a_home(page):
    """A tela de login oferece "← Página inicial" além do guia."""
    page.goto(f"{BASE}/admin/login")
    voltar = page.locator("#login .sp-login-foot a", has_text="Página inicial")
    expect(voltar).to_be_visible(timeout=15000)
    assert voltar.get_attribute("href") == f"{BASE_PATH}/"
    expect(page.locator("#login .sp-login-foot a", has_text="Como publicar")).to_be_visible()
    voltar.click()
    page.wait_for_url(f"{BASE}/")



def test_ver_site_ao_lado_do_nome_na_lista(page, admin, uid, browser):
    """Pastas que são página (e o index.html) ganham 'ver site': abre a página publicada sem sair do painel."""
    slug, pessoa = f"zz-ver-{uid}", f"zz.ver{uid}@exemplo.com"
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": "Ver"}))
    admin.write(f"/{slug}/index.html", "<h1>time</h1>")
    admin.write(f"/{slug}/pag/index.html", "<h1>pagina</h1>")
    admin.write(f"/{slug}/dados/x.json", "{}")
    admin.write(f"/{slug}/_interna/index.html", "<h1>x</h1>")
    assert admin.add_user(pessoa, "SenhaTeste123456", f"/{slug}").ok

    # membro: o endereço é <prefixo>/<time>/<pasta>/
    login_token(page, Api(pessoa, "SenhaTeste123456").token)
    pag = page.locator('#listing .item[aria-label="pag"] .sp-ver')
    expect(pag).to_be_visible(timeout=15000)
    assert pag.get_attribute("href") == f"{BASE}/{slug}/pag/" and pag.get_attribute("target") == "_blank"
    assert pag.inner_text().startswith("ver site")
    expect(page.locator('#listing .item[aria-label="dados"] .sp-ver')).to_have_count(0)        # pasta sem index.html
    expect(page.locator('#listing .item[aria-label="_interna"] .sp-ver')).to_have_count(0)     # pastas internas não
    # o index.html da raiz do time é a página do time
    expect(page.locator('#listing .item[aria-label="index.html"] .sp-ver')).to_have_attribute("href", f"{BASE}/{slug}/")
    # clicar no link não abre nem seleciona a linha
    with page.context.expect_page() as nova:
        pag.click()
    assert nova.value.url == f"{BASE}/{slug}/pag/"
    assert page.url.endswith("/admin/files/")
    nova.value.close()
    # dentro da pasta, o index.html aponta para a própria pasta
    page.goto(f"{BASE}/admin/files/pag/")
    expect(page.locator('#listing .item[aria-label="index.html"] .sp-ver')).to_have_attribute("href", f"{BASE}/{slug}/pag/", timeout=15000)

    # admin: na raiz, a linha do time leva à página do time
    ap = browser.new_page()
    login_token(ap, admin.token)
    expect(ap.locator(f'#listing .item[aria-label="{slug}"] .sp-ver')).to_have_attribute("href", f"{BASE}/{slug}/", timeout=15000)
    ap.close()


def test_painel_fica_claro_mesmo_com_o_sistema_em_modo_escuro(browser):
    """O File Browser liga html.dark sozinho com prefers-color-scheme: dark; o painel só tem tema claro."""
    ctx = browser.new_context(viewport={"width": 1280, "height": 860}, color_scheme="dark")
    pg = ctx.new_page()
    pg.errors = []
    pg.on("dialog", lambda d: d.accept())
    login(pg, ADMIN_USER, ADMIN_PASS)
    pg.wait_for_timeout(800)
    assert pg.evaluate("document.documentElement.className") == "light"
    assert pg.evaluate("getComputedStyle(document.documentElement).colorScheme") == "light"
    ctx.close()


def test_lixeira_do_editor_lista_por_item_e_restaura(page, admin, uid):
    """O editor vê na Lixeira só o que saiu do próprio time, um item por linha (sem pastas de data e lote), e restaura."""
    a, b = f"zz-lxa-{uid}", f"zz-lxb-{uid}"
    pessoa, senha, leitor_nome = f"zz.lxed{uid}", "SenhaTeste123456", f"zz.lxle{uid}"
    for slug in (a, b):
        admin.mkdir(f"/{slug}")
        admin.write(f"/{slug}/.time.json", json.dumps({"nome": slug}))
        admin.mkdir(f"/{slug}/relatorio")
        admin.write(f"/{slug}/relatorio/index.html", f"<h1>{slug}</h1>")
        admin.write(f"/{slug}/solto.txt", "x")
    assert admin.add_user(pessoa, senha, f"/{a}").ok
    assert admin.add_user(leitor_nome, senha, f"/{a}", leitor=True).ok
    editor = Api(pessoa, senha)
    # o editor apaga um arquivo; o admin apaga um arquivo do outro time
    assert editor.req("DELETE", "/resources/solto.txt").ok
    assert admin.req("DELETE", f"/resources/{b}/solto.txt").ok

    lista = requests.get(f"{ENTRA}/lixeira", headers=editor.h, timeout=10).json()
    assert [i["nome"] for i in lista] == ["solto.txt"] and lista[0]["original"] == f"/{a}/solto.txt"
    assert lista[0]["pasta"] == f"/{a}" and lista[0]["tipo"] == "arquivo" and lista[0]["quem"] == pessoa
    # leitor não mexe na lixeira
    assert requests.get(f"{ENTRA}/lixeira", headers=Api(leitor_nome, senha).h, timeout=10).status_code == 403
    # id de outro time não é aceito pelo editor
    outro = [i for i in requests.get(f"{ENTRA}/lixeira", headers=admin.h, timeout=10).json() if i["original"] == f"/{b}/solto.txt"][0]
    assert requests.post(f"{ENTRA}/lixeira/restaurar", json={"id": outro["id"]}, headers=editor.h, timeout=10).status_code == 404

    # pela tela: menu, uma linha com o nome e a pasta de origem, restaurar
    login_token(page, editor.token)
    page.goto(f"{BASE}/admin/files/")
    page.locator("nav a[data-sp-lixeira]").click()
    page.wait_for_url("**/times/lixeira.html")
    linha = page.locator(".lixo", has_text="solto.txt")
    expect(linha).to_be_visible(timeout=15000)
    assert page.locator(".lixo").count() == 1
    expect(linha).to_contain_text("pasta do time")
    linha.get_by_role("button", name="Restaurar").click()
    expect(page.locator(".empty")).to_be_visible(timeout=15000)
    assert editor.req("GET", "/raw/solto.txt").text == "x"
    # a pasta de data/lote some quando esvazia; o outro time continua na lixeira do admin
    assert any(i["original"] == f"/{b}/solto.txt" for i in requests.get(f"{ENTRA}/lixeira", headers=admin.h, timeout=10).json())

    # restaurar com o nome ocupado cria "(restaurado)"; apagar de vez remove do registro
    assert editor.req("DELETE", "/resources/solto.txt").ok
    editor.write("/solto.txt", "novo")
    item = requests.get(f"{ENTRA}/lixeira", headers=editor.h, timeout=10).json()[0]
    r = requests.post(f"{ENTRA}/lixeira/restaurar", json={"id": item["id"]}, headers=editor.h, timeout=10).json()
    assert r["destino"] == f"/{a}/solto (restaurado).txt"
    assert editor.req("GET", "/raw/solto (restaurado).txt").text == "x"
    assert editor.req("DELETE", "/resources/solto (restaurado).txt").ok
    item = requests.get(f"{ENTRA}/lixeira", headers=editor.h, timeout=10).json()[0]
    assert requests.post(f"{ENTRA}/lixeira/apagar", json={"id": item["id"]}, headers=editor.h, timeout=10).ok
    assert requests.get(f"{ENTRA}/lixeira", headers=editor.h, timeout=10).json() == []


def test_editor_ve_alterado_por_com_nome_e_nas_pastas(page, admin, uid):
    """Quem edita um time vê "Alterado por" (nome, não só admin), inclusive nas pastas, e não vê a coluna Time."""
    slug, pessoa, senha = f"zz-aut-{uid}", f"zz.autor{uid}", "SenhaTeste123456"
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": slug}))
    assert admin.add_user(pessoa, senha, f"/{slug}").ok
    editor = Api(pessoa, senha)
    editor.mkdir("/pagina-nova")
    editor.write("/pagina-nova/index.html", "<h1>x</h1>")
    editor.write("/solto.html", "<h1>y</h1>")

    # o servidor devolve o autor por arquivo e, para a pasta, o último autor de dentro
    r = requests.get(f"{ENTRA}/autoria?dir=", headers=editor.h, timeout=10).json()
    assert r["solto.html"]["email"] == pessoa and r["pagina-nova"]["email"] == pessoa
    # nunca sai do escopo do time
    assert requests.get(f"{ENTRA}/autoria?dir=../", headers=editor.h, timeout=10).status_code == 400
    assert requests.get(f"{ENTRA}/autoria?dir=", timeout=10).status_code == 401

    login_token(page, editor.token)
    page.goto(f"{BASE}/admin/files/")
    linha_arquivo = page.locator('#listing .item[aria-label="solto.html"]')
    linha_pasta = page.locator('#listing .item[aria-label="pagina-nova"]')
    expect(linha_arquivo.locator("p.sp-who")).to_have_text(pessoa, timeout=15000)
    expect(linha_pasta.locator("p.sp-who")).to_have_text(pessoa)
    assert page.locator("#listing .item.header p.sp-team").count() == 0
    expect(page.locator("#listing .item.header p.sp-who")).to_contain_text("Alterado por")


def test_barra_troca_o_nome_ao_trocar_de_conta_sem_recarregar(page, admin, uid):
    """O painel é uma SPA: sair e entrar com outra conta não recarrega a página; o nome da conta anterior não pode ficar."""
    slug, pessoa, senha = f"zz-troca-{uid}", f"zz.troca{uid}", "SenhaTeste123456"
    admin.mkdir(f"/{slug}")
    admin.write(f"/{slug}/.time.json", json.dumps({"nome": "Time Troca"}))
    assert admin.add_user(pessoa, senha, f"/{slug}").ok
    outro = Api(pessoa, senha)

    login_token(page, admin.token)
    expect(page.locator("[data-sp-chip] .sp-chip-user")).to_have_text(ADMIN_USER, timeout=15000)
    # troca a sessão sem recarregar o documento e provoca um ciclo do inject.js
    page.evaluate("t => localStorage.setItem('jwt', t)", outro.token)
    page.evaluate("document.body.append(document.createElement('i'))")
    expect(page.locator("[data-sp-chip] .sp-chip-user")).to_have_text(pessoa, timeout=15000)
    expect(page.locator("[data-sp-chip] .sp-chip-role")).to_have_text("Editor")

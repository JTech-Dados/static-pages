"""Prints do painel (lixeira) para o README (dados fictícios; Acessos e Atividade: screenshots_acessos.py) -> docs/img/

Cria times de demonstração temporários (removidos no final, inclusive da
lixeira) e simula Atividade/Lixeira interceptando as respostas, para que
nenhum nome real do servidor apareça nas imagens.

Uso:  FB_PASS=... python divulgacao/screenshots_painel.py
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))
from conftest import BASE, Api  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(__file__).parent.parent / "docs" / "img"
TEAMS = {
    "zz-vendas": ("Vendas", 500, ["ana.souza", "bruno.lima", "carla.dias"], ["relatorio-mensal", "metas-2026"]),
    "zz-marketing": ("Marketing", 200, ["diego.alves"], ["campanha-verao"]),
    "zz-produto": ("Produto", None, ["eva.martins", "fabio.rocha"], ["roadmap", "prototipo-app", "pesquisa-ux"]),
}
FAKE_LOG = "\n".join([
    "2026-10-20T13:05:00Z\tana.souza\tafter_upload\t/srv/vendas/relatorio-mensal/index.html\t",
    "2026-10-20T14:12:00Z\tbruno.lima\tafter_save\t/srv/vendas/metas-2026/index.html\t",
    "2026-10-20T15:40:00Z\tdiego.alves\tafter_upload\t/srv/marketing/campanha-verao/banner.webp\t",
    "2026-10-21T09:02:00Z\teva.martins\tafter_rename\t/srv/produto/rascunho\t/srv/produto/prototipo-app",
    "2026-10-21T10:15:00Z\tfabio.rocha\tafter_delete\t/srv/produto/pesquisa-ux/antigo.html\t",
    "2026-10-21T10:31:00Z\tadmin\tafter_rename\t/srv/_lixeira/2026-10-21/103100-1/produto/pesquisa-ux/antigo.html\t/srv/produto/pesquisa-ux/antigo.html",
    "2026-10-21T11:20:00Z\tcarla.dias\tafter_upload\t/srv/vendas/relatorio-mensal/dados.json\t",
]) + "\n"
FAKE_TRASH = "\n".join([
    "2026-10-21T08:10:00Z\tbruno.lima\t/vendas/metas-2025\t/_lixeira/2026-10-21/081000-1/vendas/metas-2025",
    "2026-10-21T09:45:00Z\tdiego.alves\t/marketing/campanha-verao/rascunho.html\t/_lixeira/2026-10-21/094500-2/marketing/campanha-verao/rascunho.html",
    "2026-10-21T10:15:00Z\tfabio.rocha\t/produto/pesquisa-ux/antigo.html\t/_lixeira/2026-10-21/101500-3/produto/pesquisa-ux/antigo.html",
]) + "\n"


def setup(api):
    for slug, (nome, cota, pessoas, paginas) in TEAMS.items():
        api.write(f"/{slug}/.time.json", json.dumps({"nome": nome, **({"cota_mb": cota} if cota else {})}))
        api.write(f"/{slug}/index.html", "<h1>time</h1>")
        for p in paginas:
            api.write(f"/{slug}/{p}/index.html", "<h1>pagina</h1>" + "x" * 40000)
        for u in pessoas:
            api.add_user(f"zz.{u}", "SenhaDemo123456!", f"/{slug}")


def shoot():
    OUT.mkdir(parents=True, exist_ok=True)
    api = Api("admin", os.environ["FB_PASS"])
    api.cleanup()
    setup(api)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL") or None, executable_path=os.environ.get("BROWSER_PATH") or None)
            pg = b.new_page(viewport={"width": 1280, "height": 860}, device_scale_factor=2)
            pg.goto(f"{BASE}/admin/login")
            pg.evaluate("t => localStorage.setItem('jwt', t)", api.token)

            # nomes "zz." e "/zz-" nunca aparecem: troca no DOM antes do print
            clean = """() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                for (let n; (n = w.nextNode());) n.nodeValue = n.nodeValue.replace(/\\bzz[.-]/g, "");
                document.querySelectorAll(".members li").forEach((li) => {
                  const a = li.querySelector(".avatar"), name = li.querySelector(".who span:last-child");
                  if (a && name) a.textContent = name.textContent.charAt(0);
                }); }"""

            pg.route("**/admin/api/raw/_lixeira/.registro", lambda r: r.fulfill(body=FAKE_TRASH, content_type="text/plain"))
            pg.route("**/admin/_auditoria", lambda r: r.fulfill(body=FAKE_LOG, content_type="text/plain"))
            pg.goto(f"{BASE}/admin/times#lixeira", wait_until="networkidle")
            pg.wait_for_timeout(1000)
            pg.evaluate(clean)
            pg.screenshot(path=OUT / "lixeira.png", clip={"x": 0, "y": 0, "width": 1280, "height": 560})

            b.close()
    finally:
        api.cleanup()
    print("ok:", [f.name for f in OUT.glob("*.png")])


if __name__ == "__main__":
    shoot()

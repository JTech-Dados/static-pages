"""Capturas do README (1280x800 @2x) -> docs/img/*.png

Uso:  FB_USER=admin FB_PASS=... python divulgacao/screenshots.py
"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:8080")
OUT = Path(__file__).parent.parent / "docs" / "img"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=2)

        # Home com pastas fictícias: intercepta /_pastas/ e os meta.json
        # para o print não expor as pastas reais do servidor.
        # Árvore: caminho -> (tem index.html?, meta)
        demo = {
            "relatorio-vendas": (True, {"titulo": "Relatório de Vendas", "descricao": "Resultados do trimestre por região.", "tag": "Dashboard", "ordem": 1}),
            "relatorio-vendas/norte": (True, {}),
            "relatorio-vendas/sul": (True, {}),
            "landing-evento": (True, {"titulo": "Landing do Evento", "descricao": "Inscrições e programação.", "tag": "Campanha", "ordem": 2}),
            "docs-api": (True, {"titulo": "Documentação da API", "descricao": "Endpoints, exemplos e changelog.", "tag": "Docs", "ordem": 3}),
            "docs-api/v1": (True, {}),
            "docs-api/v2": (True, {}),
            "prototipos": (False, {"descricao": "Testes de interface."}),
            "prototipos/app-mobile": (True, {}),
            "prototipos/checkout": (True, {}),
            "roadmap": (True, {"descricao": "Entregas planejadas para o ano."}),
        }
        cors = {"Access-Control-Allow-Origin": "*"}

        def listing(route, request):
            base = request.url.split("/_pastas/", 1)[1].strip("/")
            prefix = base + "/" if base else ""
            entries = [{"name": k[len(prefix):], "type": "directory"} for k in demo
                       if k.startswith(prefix) and "/" not in k[len(prefix):]]
            if base in demo and demo[base][0]:
                entries.append({"name": "index.html", "type": "file"})
            route.fulfill(json=entries, headers=cors)

        def meta(route, request):
            path = request.url.split("://", 1)[1].split("/", 1)[1].rsplit("/meta.json", 1)[0]
            data = demo.get(path, (False, {}))[1]
            route.fulfill(json=data, headers=cors) if data else route.fulfill(status=204, headers=cors)

        page.route("**/_pastas/**", listing)
        page.route("**/meta.json", meta)
        page.goto(BASE + "/", wait_until="networkidle")
        page.wait_for_timeout(800)
        page.screenshot(path=OUT / "site.png")
        page.unroute_all()

        for name, path in [("404", "/nao-existe"), ("login", "/admin/login")]:
            page.goto(BASE + path, wait_until="networkidle")
            page.screenshot(path=OUT / f"{name}.png")

        page.fill("input[type=text]", os.environ["FB_USER"])
        page.fill("input[type=password]", os.environ["FB_PASS"])
        page.keyboard.press("Enter")
        page.wait_for_url("**/admin/files/**")
        # ADMIN_DIR: pasta de demonstração (evita expor pastas reais no print)
        admin_dir = os.environ.get("ADMIN_DIR", "")
        if admin_dir:
            page.goto(f"{BASE}/admin/files/{admin_dir}/")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(500)
        page.screenshot(path=OUT / "admin.png")

        browser.close()
    for f in sorted(OUT.glob("*.png")):
        print(f.name)


if __name__ == "__main__":
    main()

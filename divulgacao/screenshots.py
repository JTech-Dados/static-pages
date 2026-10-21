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

        for name, path in [("site", "/"), ("404", "/nao-existe"), ("login", "/admin/login")]:
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

"""Banner 1280x640 do README / social preview do GitHub -> docs/img/banner.png"""
import subprocess
from pathlib import Path

import build

OUT = Path(__file__).parent.parent / "docs" / "img"
W, H = 1280, 640

CSS = """
html,body{width:1280px;height:640px;overflow:hidden}
body{padding:80px;gap:0;justify-content:center;background:#fafafa}
body::before{inset:-20%;filter:blur(70px);
 background:radial-gradient(28% 40% at 82% 20%,#007cf040,transparent 70%),
 radial-gradient(25% 35% at 92% 75%,#ff008030,transparent 70%),
 radial-gradient(25% 35% at 65% 95%,#00dfd838,transparent 70%),
 radial-gradient(20% 30% at 70% 45%,#f9cb2830,transparent 70%)}
.wrap{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:56px;align-items:center}
.brand{margin-bottom:36px}
h1{font-size:72px;letter-spacing:-3px;line-height:1.18}
.sub{font-size:26px;line-height:1.45;color:var(--muted);margin-top:20px;text-wrap:pretty}
.chips{display:flex;gap:12px;margin-top:32px;flex-wrap:wrap}
.chip{font-family:var(--mono);font-size:19px;padding:8px 16px;border-radius:999px;background:var(--card);box-shadow:var(--ring)}
.term{background:#171717;color:#ededed;border-radius:16px;padding:28px 30px;font-family:var(--mono);font-size:19px;line-height:1.75;
 box-shadow:0 1px 1px #00000008,0 12px 24px -6px #00000026,0 32px 48px -12px #0000002e}
.dots{display:flex;gap:8px;margin-bottom:18px}.dots i{width:12px;height:12px;border-radius:50%;background:#3f3f3f}
.p{color:#888}.ok{color:#50e3c2}.b{color:#7fb6ff}
"""

BODY = f"""
<div class="wrap">
 <div>
  <div class="brand">{build.LOGO}static-pages</div>
  <h1>Site estático + painel de arquivos. Um container.</h1>
  <p class="sub">NGINX serve o site, File Browser edita em <span class="mono">/admin</span>. Pronto para VPS.</p>
  <div class="chips"><span class="chip">Docker</span><span class="chip">NGINX</span><span class="chip">File Browser</span><span class="chip">MIT</span></div>
 </div>
 <div class="term">
  <div class="dots"><i></i><i></i><i></i></div>
  <div><span class="p">$</span> cp .env.example .env</div>
  <div><span class="p">$</span> docker compose up -d --build</div>
  <div class="ok">✔ static-pages  healthy</div>
  <div><span class="p">→</span> <span class="b">http://localhost:8080/</span></div>
  <div><span class="p">→</span> <span class="b">http://localhost:8080/admin/</span></div>
 </div>
</div>
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    html = OUT.parent / "_banner.html"
    html.write_text(
        f"<!doctype html><html lang='pt-br'><head><meta charset='utf-8'><style>{build.BASE}{CSS}</style>"
        f"</head><body>{BODY}</body></html>", encoding="utf-8")
    png = OUT / "banner.png"
    subprocess.run([build.EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    f"--window-size={W},{H}", "--virtual-time-budget=4000",
                    f"--screenshot={png}", html.as_uri()], check=True, capture_output=True)
    html.unlink()
    print(png)


if __name__ == "__main__":
    main()

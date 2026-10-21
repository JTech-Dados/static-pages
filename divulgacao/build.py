"""Carrossel 1080x1350 do static-pages: HTML -> PNG (Edge headless) -> PDF."""
import subprocess
from pathlib import Path

from PIL import Image

OUT = Path(__file__).parent
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
W, H = 1080, 1350

LOGO = (OUT.parent / "content" / "favicon.svg").read_text(encoding="utf-8")

BASE = """
@import url("https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap");
:root{--bg:#fafafa;--card:#fff;--text:#171717;--muted:#4d4d4d;--mute:#888;
--line:#ebebeb;--accent:#0070f3;--ok:#0a7a3d;--bad:#c50000;
--ring:inset 0 0 0 1px #00000014;--elev:0 1px 1px #00000005,0 8px 16px -4px #0000000a,0 24px 32px -8px #0000000f;
--sans:Geist,Inter,"Segoe UI",sans-serif;--mono:"Geist Mono",Consolas,monospace}
*{box-sizing:border-box;margin:0}
html,body{width:1080px;height:1350px;overflow:hidden}
body{font-family:var(--sans);color:var(--text);background:var(--bg);padding:72px;
 display:flex;flex-direction:column;gap:56px;position:relative;-webkit-font-smoothing:antialiased}
body>*{flex-shrink:0;position:relative;z-index:1}
body::before{content:"";position:absolute;inset:-10%;z-index:0;filter:blur(60px);
 background:radial-gradient(30% 25% at 85% 8%,#007cf022,transparent 70%),
 radial-gradient(30% 25% at 10% 95%,#ff008018,transparent 70%)}
.top{display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:16px;font-weight:600;font-size:26px;letter-spacing:-.6px}
.brand svg{width:56px;height:56px}
.tag{font-family:var(--mono);font-size:22px;color:var(--muted);padding:8px 18px;border-radius:999px;
 background:var(--card);box-shadow:var(--ring)}
h1{font-size:84px;line-height:1.18;font-weight:600;letter-spacing:-3px;text-wrap:balance}
.card{background:var(--card);border-radius:16px;box-shadow:var(--ring),var(--elev);padding:36px}
.mono{font-family:var(--mono)}
.foot{margin-top:auto;display:flex;justify-content:space-between;font-family:var(--mono);font-size:22px;color:var(--mute)}
"""


def page(css: str, body: str, n: int) -> str:
    top = f'<div class="top"><div class="brand">{LOGO}static-pages</div><span class="tag">{n}/3</span></div>'
    hint = "arraste →" if n < 3 else "salve para o próximo deploy"
    foot = f'<div class="foot"><span>Docker · NGINX · File Browser</span><span>{hint}</span></div>'
    return (f"<!doctype html><html lang='pt-br'><head><meta charset='utf-8'>"
            f"<style>{BASE}{css}</style></head><body>{top}{body}{foot}</body></html>")


S1_CSS = """
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.col h2{margin-bottom:24px}
.pill{font-family:var(--mono);font-size:20px;font-weight:500;padding:4px 12px;border-radius:999px}
.antes .pill{background:#f7d4d6;color:var(--bad)} .depois .pill{background:#d3e5ff;color:#0761d1}
.col ul{list-style:none;padding:0;display:flex;flex-direction:column;gap:26px}
.col li{font-size:29px;line-height:1.35;padding-left:32px;position:relative;text-wrap:pretty}
.antes li::before{content:"×";position:absolute;left:0;color:var(--bad);font-weight:600}
.depois li::before{content:"✓";position:absolute;left:0;color:var(--accent);font-weight:600}
"""
S1 = """
<h1>Um Dockerfile de POC virou um container pronto para VPS.</h1>
<div class="cols">
 <div class="card col antes"><h2><span class="pill">antes</span></h2><ul>
  <li>Script de startup inteiro dentro do <span class="mono">CMD</span></li>
  <li>Senha padrão fixa no código</li>
  <li>Imagens <span class="mono">:latest</span></li>
  <li>Sem healthcheck nem tratamento de sinal</li>
  <li>Uploads na mesma origem do admin</li>
 </ul></div>
 <div class="card col depois"><h2><span class="pill">depois</span></h2><ul>
  <li><span class="mono">entrypoint.sh</span> separado e testável</li>
  <li>Senha aleatória exibida uma única vez</li>
  <li>Versões fixadas</li>
  <li><span class="mono">tini</span> + healthcheck + código de saída</li>
  <li>Site isolado com CSP <span class="mono">sandbox</span></li>
 </ul></div>
</div>
"""

S2_CSS = """
.node{display:flex;align-items:center;gap:24px;padding:40px 36px}
.node .k{font-family:var(--mono);font-size:21px;color:var(--mute);width:150px;flex-shrink:0}
.node .v{font-size:32px;font-weight:500;letter-spacing:-.4px}
.node .d{font-size:25px;color:var(--muted);margin-top:4px;line-height:1.35}
.arrow{height:48px;margin-left:104px;border-left:2px dashed #a1a1a1}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.split .node{flex-direction:column;align-items:flex-start;gap:10px}
.route{font-family:var(--mono);font-size:24px;font-weight:500;color:var(--accent)}
"""
S2 = """
<h1>Um container, duas portas de entrada.</h1>
<div>
 <div class="card node"><span class="k">entrada</span><div><div class="v">NGINX da VPS (HTTPS)</div><div class="d">proxy para 127.0.0.1:8080</div></div></div>
 <div class="arrow"></div>
 <div class="card node"><span class="k">container</span><div><div class="v">NGINX :80</div><div class="d">rate limit no login · dotfiles 404 · gzip · cache</div></div></div>
 <div class="arrow"></div>
 <div class="split">
  <div class="card node"><span class="route">/</span><div class="v">Site estático</div><div class="d">arquivos de /srv, isolados do admin</div></div>
  <div class="card node"><span class="route">/admin</span><div class="v">File Browser</div><div class="d">edita /srv pelo navegador, ouvindo só em 127.0.0.1</div></div>
 </div>
</div>
"""

S3_CSS = """
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.grid .card{padding:44px 40px;display:flex;flex-direction:column;gap:14px}
.grid h3{font-size:34px;font-weight:600;letter-spacing:-.6px}
.grid p{font-size:26px;line-height:1.4;color:var(--muted);text-wrap:pretty}
.n{font-family:var(--mono);font-size:20px;color:var(--accent)}
.bugs{font-size:28px;line-height:1.45;color:var(--muted);text-wrap:pretty}
.bugs b{color:var(--text);font-weight:600}
"""
S3 = """
<h1>Quatro pilares.</h1>
<div class="grid">
 <div class="card"><span class="n">01</span><h3>Segurança</h3><p>CSP sandbox, rate limit no login, senha aleatória, dotfiles bloqueados.</p></div>
 <div class="card"><span class="n">02</span><h3>Robustez</h3><p>tini como PID&nbsp;1, healthcheck, o container cai junto se um processo cair.</p></div>
 <div class="card"><span class="n">03</span><h3>Deploy</h3><p>docker compose, .env.example e um .bat para subir local com dois cliques.</p></div>
 <div class="card"><span class="n">04</span><h3>Visual</h3><p>DESIGN.md como contrato, admin com tema próprio, pt-br e logo novo.</p></div>
</div>
<p class="bugs"><b>Bastidor:</b> rodar de verdade revelou 4&nbsp;bugs que a leitura do código não mostrava, entre eles uma regex do NGINX capturando os assets do&nbsp;admin.</p>
"""

SLIDES = {1: (S1_CSS, S1), 2: (S2_CSS, S2), 3: (S3_CSS, S3)}


def render(n: int) -> Path:
    css, body = SLIDES[n]
    html = OUT / f"slide{n}.html"
    png = OUT / f"slide{n}.png"
    html.write_text(page(css, body, n), encoding="utf-8")
    subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    f"--window-size={W},{H}", "--virtual-time-budget=4000",
                    f"--screenshot={png}", html.as_uri()], check=True, capture_output=True)
    return png


def main() -> None:
    pngs = [render(n) for n in SLIDES]
    Image.init()
    imgs = [Image.open(p).convert("RGB") for p in pngs]
    imgs[0].save(OUT / "carrossel.pdf", save_all=True, append_images=imgs[1:],
                 resolution=72.0, quality=95)
    for p in pngs:
        print(p.name, Image.open(p).size)


if __name__ == "__main__":
    main()

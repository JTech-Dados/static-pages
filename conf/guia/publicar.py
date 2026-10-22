#!/usr/bin/env python3
"""Publica um HTML no Pages com um token de API (só biblioteca padrão do Python 3.8+).

Uso:
    export PAGES_TOKEN=sp_...                    # crie em Tokens de API, no painel
    python3 publicar.py --url https://<domínio>/pages --pasta relatorio-mensal relatorio.html
    python3 publicar.py --url ... --pasta relatorio-mensal relatorio.html --atualizar

--atualizar apaga o arquivo atual (vai para a lixeira por 30 dias) e publica de novo; sem ele,
uma página que já existe é recusada. A página fica em <url>/<seu-time>/<pasta>/. Admin informa o time com --time.
O token vale como a sua conta: guarde no cofre de segredos da ferramenta de automação.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 5 * 1024 * 1024


def chamar(metodo, url, corpo=None, cabecalhos=None):
    req = urllib.request.Request(url, data=corpo, method=metodo, headers=cabecalhos or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def sair(msg, codigo=1):
    print(f"erro: {msg}", file=sys.stderr)
    sys.exit(codigo)


def main():
    ap = argparse.ArgumentParser(description="Publica um HTML no Pages com um token de API.")
    ap.add_argument("arquivo", help="arquivo HTML a publicar")
    ap.add_argument("--url", default=os.environ.get("PAGES_URL"), help="endereço do Pages, ex.: https://dominio/pages (ou PAGES_URL)")
    ap.add_argument("--time", help="pasta do time (só para admin; membros publicam no próprio time)")
    ap.add_argument("--pasta", required=True, help="nome da página (minúsculas, números e hífen)")
    ap.add_argument("--atualizar", action="store_true", help="substitui a página existente (a versão anterior vai para a lixeira)")
    a = ap.parse_args()

    token = os.environ.get("PAGES_TOKEN", "")
    if not a.url:
        sair("informe --url ou PAGES_URL")
    if not token.startswith("sp_"):
        sair("defina PAGES_TOKEN com o token criado em Tokens de API")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", a.pasta):
        sair("--pasta deve ter só minúsculas, números e hífen (ex.: relatorio-mensal)")
    try:
        html = open(a.arquivo, "rb").read()
    except OSError as e:
        sair(f"não consegui ler {a.arquivo}: {e}")
    if len(html) > MAX_BYTES:
        sair("arquivo maior que 5 MB; coloque imagens e dados grandes fora do HTML")
    base = a.url.rstrip("/")

    # 1) troca o token por uma sessão
    st, corpo = chamar("POST", f"{base}/admin/entra/api/sessao", json.dumps({"token": token}).encode(), {"Content-Type": "application/json"})
    if st == 401:
        sair("token inválido, expirado ou revogado: crie outro em Tokens de API")
    if st != 200:
        sair(f"não foi possível abrir a sessão (HTTP {st})")
    jwt = json.loads(corpo)["jwt"]
    auth = {"X-Auth": jwt}
    # quem sou: membro publica no próprio time; admin informa o time
    st, corpo = chamar("GET", f"{base}/admin/entra/me", None, auth)
    eu = json.loads(corpo) if st == 200 else {}
    time = a.time if eu.get("admin") else eu.get("time", "")
    if eu.get("admin") and not time:
        sair("você é admin: informe o time com --time")
    if not eu.get("admin") and a.time:
        print("aviso: --time é ignorado (você publica no seu time)", file=sys.stderr)
    prefixo = f"{urllib.parse.quote(time)}/" if eu.get("admin") else ""   # o escopo do membro já é a pasta do time
    caminho = f"{base}/admin/api/resources/{prefixo}{urllib.parse.quote(a.pasta)}/index.html"

    # 2) (opcional) apaga a versão atual: vai para a lixeira
    if a.atualizar:
        st, _ = chamar("DELETE", caminho, None, auth)
        if st not in (204, 200, 404):
            sair(f"não consegui remover a versão atual (HTTP {st})")

    # 3) publica; sem override, o servidor recusa se já existir (409). urllib envia Content-Length.
    st, corpo = chamar("POST", caminho + "?override=false", html, {**auth, "Content-Type": "text/html"})
    if st == 409:
        sair(f"a página '{a.pasta}' já existe; use --atualizar para substituir")
    if st == 413:
        sair(corpo.decode("utf-8", "replace") or "o espaço do time acabou: apague arquivos antigos ou peça mais espaço")
    if st == 403:
        sair("seu papel não permite publicar (Leitor só consulta) ou o caminho está fora do seu time")
    if st not in (200, 201):
        sair(f"falha ao publicar (HTTP {st})")
    print(f"publicado: {base}/{time}/{a.pasta}/" if time else f"publicado: {base}/{a.pasta}/")


if __name__ == "__main__":
    main()

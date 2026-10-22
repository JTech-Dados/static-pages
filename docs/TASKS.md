# TASKS — o que falta

> Backlog vivo. Cada item tem prioridade e critério de pronto. Ao concluir, mova para "Feito" com a data e o commit.
> Prioridade: 🔴 alta · 🟡 média · 🔵 quando o uso crescer

## Em aberto

| Pri | Tarefa | Pronto quando |
|---|---|---|
| 🔴 | **Deploy na VPS** atrás do NGINX existente | `HTTP_BIND=127.0.0.1`, senha forte, HTTPS no proxy, `/healthz` 200 pelo domínio, backup gerando em `./backups` |
| 🔴 | **Backup fora da VPS** (hoje fica no mesmo disco) | cópia diária para storage externo (S3/Blob/rsync) e restauração testada a partir dela |
| 🟡 | Backup consistente do `filebrowser.db` | backup copia o banco sem risco de pegar escrita no meio (snapshot ou pausa curta do app) |
| 🟡 | Publicar imagem no GHCR pelo CI | VPS faz `docker compose pull` (sem build); tag por commit e `latest` estável |
| 🟡 | Remover a pasta `_backup` criada no setup inicial | conteúdo conferido e apagado, ou movido para `./backups` |
| 🔵 | Admin em subdomínio próprio | `/admin` só em `admin.<domínio>`; CSP sandbox do site pode ser revisto (decisão na MEMORY) |
| 🔵 | Acesso restrito, modo A (assets e `fetch` com cookie) | decidir após testar a matriz de navegadores; hoje a v1 só protege a navegação e o conteúdo restrito precisa ser autocontido |
| 🔵 | Tema escuro | botão de tema no topo do painel e da home, escolha guardada no navegador |
| 🔵 | Validar o login Microsoft com um tenant real no Redirect URI padrão | `…/admin/entra/retorno` cadastrado no app Entra e login completo testado (a suíte usa só um Entra de teste) |
| 🔵 | Filtrar robôs no contador de visitas | User-Agents de bots conhecidos não contam |

## Feito

| Data | Entrega | Commit |
|---|---|---|
| 2026-10-22 | Pedir acesso em página restrita (botão na tela de entrada, pedidos e aprovação na tela Acesso restrito, contador no menu) | (este commit) |
| 2026-10-22 | Painel sempre no tema claro; Lixeira no menu para editores (lista por item); prompt para o Claude nos tokens de API; restrição por página com lista própria; correção do acesso restrito com espaço/acento; "Alterado por" com nome para todos; contador de visitas com acento; barra do painel esquece a conta anterior | (este commit) |
| 2026-10-23 | Tokens de API (tela, troca por sessão, script `publicar.py`), acesso restrito por time com login Microsoft (v1), "ver site ↗" na lista de arquivos, login com caminho de volta para a home | (este commit) |
| 2026-10-22 | Login Microsoft (Entra ID) no painel com pedido de acesso e aprovação; aba Usuários (papel e time); cota por time que bloqueia upload (inclusive o tus da interface); espaço do time no menu; nomes curtos; guia "Como publicar" (`/_ajuda/`); histórico de acessos na Atividade; `SP_BASE` (prefixo público); painel conferido em 360 px | — |
| 2026-10-21 | Lixeira, backup, atividade, visitas, modelo de time, testes E2E + CI | `b3849a6`, `7e2e6d8` |
| 2026-10-21 | Home por times; colunas Time/Alterado por | `72eb8ca` |
| 2026-10-21 | Tela de Times; cadastro público desligado | `b2e352d` |
| 2026-10-21 | Menu automático da home (até 3 níveis) | `0072e5d` |
| 2026-10-21 | README, prints, licença MIT | `81f824b` |
| 2026-10-21 | Container base (NGINX + File Browser) | `1c9a60a` |

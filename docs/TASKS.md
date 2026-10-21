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
| 🔵 | **Login de leitura por time** (oauth2-proxy + Entra ID) | páginas de um time só abrem para quem está no grupo do AD; home mostra só os times permitidos |
| 🔵 | Admin em subdomínio próprio | `/admin` só em `admin.<domínio>`; CSP sandbox do site pode ser revisto (decisão na MEMORY) |
| 🔵 | Cota que bloqueia upload | upload acima da cota é recusado com mensagem clara |
| 🔵 | Filtrar robôs no contador de visitas | User-Agents de bots conhecidos não contam |

## Feito

| Data | Entrega | Commit |
|---|---|---|
| 2026-10-21 | Lixeira, backup, atividade, visitas, modelo de time, testes E2E + CI | `b3849a6`, `7e2e6d8` |
| 2026-10-21 | Home por times; colunas Time/Alterado por | `72eb8ca` |
| 2026-10-21 | Tela de Times; cadastro público desligado | `b2e352d` |
| 2026-10-21 | Menu automático da home (até 3 níveis) | `0072e5d` |
| 2026-10-21 | README, prints, licença MIT | `81f824b` |
| 2026-10-21 | Container base (NGINX + File Browser) | `1c9a60a` |

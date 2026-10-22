# Segurança

## Reportar uma vulnerabilidade

**Não abra issue pública.** Use o [aviso privado de vulnerabilidade do GitHub](https://github.com/JTech-Dados/static-pages/security/advisories/new) ou fale diretamente com os mantenedores da organização.

Inclua:
- o que é possível fazer (impacto);
- passos para reproduzir;
- versão ou commit afetado.

Respondemos em até 5 dias úteis. A correção segue o fluxo normal (spec, testes e CI), e o reporte é creditado se você quiser.

## Modelo de ameaças (resumo)

| Protegido | Como |
|---|---|
| Sessão do admin contra HTML enviado por upload | CSP `sandbox` no site |
| Login | rate limit de 5/min por IP; cadastro público desligado |
| Arquivos internos (`.env`, `.autoria`, lixeira, backups) | 404 no NGINX |
| Isolamento entre times | escopo por usuário no File Browser |
| Histórico de atividade | só admin (`auth_request` na própria API) |
| Login Microsoft | ID token validado no servidor (assinatura, emissor, audiência, tenant, validade, uso único); admin local só por senha; senha de membro trocada a cada login; endpoints públicos com limite por IP |

**Fora do modelo hoje:** controle de leitura do site (as páginas são públicas para quem tem a URL) e HTTPS dentro do container (responsabilidade do proxy da VPS).

Regras completas: [docs/RULES.md](docs/RULES.md).

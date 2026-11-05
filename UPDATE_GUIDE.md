# Guia de Atualização (esboço — detalhado na ETAPA 9)

Este documento ц╘ visto em detalhe quando o sistema de atualização for
implementado. Regras j� garantidas pela arquitetura:

## Por que é seguro atualizar

- **Todo dado do usuário fica fora da pasta do código.**
  `%APPDATA%\Geraldo\` guarda sessão do WhatsApp, banco, configurações,
  API keys, memória e mídias. O atualizador troca apenas o diretório da
  versão — dados intocados.
- Instalação com processo auxiliar no Windows (o `.exe` em uso não impede
  a troca de arquivos), backup automático antes de aplicar.
- Rollback automático se a nova versão não passar na checagem de saúde.
- Sempre mantemos as duas últimas versões instaladas.

## Fluxo previsto

1. UpdateService verifica versões nos GitHub Releases do repositório
   configurado (`config.updates.owner/repo/canal`).
2. Compara com SemVer contra a versão local e respeita o canal
   (stable/beta/development).
3. Download do pacote via HTTPS com limite de tamanho, verificação de
   SHA-256 e (quando configurado) assinatura Ed25519 do manifesto.
4. Extração em temporário + verificação de arquivos obrigatórios.
5. Backup → troca de versão → migrações do SQLite → reinício → checagem
   de saúde → rollback completo em caso de falha.

## Estado atual

Ainda **não implementado** (ETAPA 9). A atualização manual, por enquanto,
é via `git pull && npm install` nesta pasta — os dados em `%APPDATA%`
sobrevivem pois não fazem parte do repositório.

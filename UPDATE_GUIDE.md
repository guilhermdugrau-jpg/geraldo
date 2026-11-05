# Guia de Atualização (ETAPA 9 — o que existe de fato)

Este guia descreve o atualizador **como ele foi implementado e
validado** (suíte 211/211 + smoke com rede real). Nada aqui é planejo:
se um comportamento é limitação, ele está escrito como limitação.

## Princípio que sustenta tudo

**Dados do usuário ficam fora da troca.** `%APPDATA%\Geraldo` guarda

```
%APPDATA%\Geraldo\
  geraldo.db     <- conversas, memória, catálogo de mídia
  config.json    <- configurações (inclui a seção updates)
  whatsapp-session/, media/, backups/, logs/, updates/
```

A atualização troca **apenas código compilado**: `backend/dist` e
`frontend/dist`. Banco, config, sessão do WhatsApp, mídia e logs
continuam intocados — é por isso que atualizar não perde nada.

## De onde vem o pacote

- O Geraldo lê os **releases publicados** de um repo público,
  configurado no painel (Atualizações → "De onde vem atualização").
  A leitura é pela **API aberta do GitHub, sem token** (60
  pedidos/h por IP — o atualizador checa no boot e a cada
  `intervalHours`).
- **Canais**: `stable` só aceita release final (sem prerelease);
  `beta` e `development` também aceitam prerelease (**hoje os dois
  são iguais** — o GitHub não expõe rascunho/draft, em nenhum canal).
- Comparação por SemVer (aceita tag `v0.2.0` e também datas do
  GitHub tipo `2026.10.26`); versão local podre → conservador, não
  atualiza.

## Formato do bundle (convenção)

Um `.zip` anexado ao release contendo na raiz:

```
version.txt        <- ex.: 0.2.0 (obrigatório; sem ele o pacote é recusado)
backend/           <- conteúdo de backend/dist (obrigatório)
frontend/          <- conteúdo de frontend/dist (obrigatório)
START.bat          <- opcional; substitui o da raiz se vier
```

Opcionalmente um `<pacote>.sha256` (ex. `geraldo-0.2.0.zip.sha256`)
com o hash do zip. **Se o release não publicar checksum, o pacote
baixado aparece com `verified: null`** — o Geraldo diz que não
conferiu, em vez de fingir que conferiu. Se publicar e o hash não
bater, o pacote é **recusado e nada é guardado**.

## Fluxo no painel (Atualizações)

1. **Verificar no GitHub** — consulta o repo configurado e mostra
   a versão mais nova, changelog (notas do release) e o zip
   escolhido. Fracasso aqui (rede, 404, repo sem release) aparece
   na tela com o motivo real.
2. **Baixar pacote** — baixa o zip pra `<APPDATA>\Geraldo\updates\
   staged\` (teto de **400 MB**; baixa grande demais é descartada
   antes de tocar disco).
3. **Preparar instalação** — extrai em `pending/` e valida o
   conteúdo (version.txt + backend/ + frontend/). Pacote estranho é
   recusado com explicação e limpo.
4. **Aplicar agora (com confirmação)** — você confirma; a rota
   responde 202 e **o Geraldo se fecha em ~1,5 s**. Em paralelo um
   helper desatachado (`apply-update.cmd`) roda fora do processo:

   - backup completo dos dists atuais em
     `<APPDATA>\Geraldo\updates\backups\<versão-atual>-antes-<carimbo>\`;
   - troca `backend/dist` e `frontend/dist` pelo pacote (robocopy
     /MIR);
   - copia `version.txt` pra raiz do `backend/` (é isso que faz o
     painel mostrar a versão nova);
   - copia `START.bat` se o bundle trouxer um.

5. **Reabre com START.bat** (modo produção, painel na **4820**).
   Entre o fechamento e o reabrir, os dados não saem do lugar.

O script do helper fica em `<APPDATA>\Geraldo\updates\apply-update.cmd`
se você quiser ler o que ele executa antes de confirmar. Não toca
`package.json`, `node_modules`, banco nem sessão.

## Rollback (manual, de verdade — não há automático)

Antes de trocar o dist, o helper guarda a versão anterior em:

```
<APPDATA>\Geraldo\updates\backups\<versão>-antes-<data-hora>\
  backend-dist\
  frontend-dist\
```

Pra voltar (Prompt de comando, pasta do código):

```
robocopy "%APPDATA%\Geraldo\updates\backups\<pasta-do-backup>\backend-dist"  "backend\dist"  /MIR
robocopy "%APPDATA%\Geraldo\updates\backups\<pasta-do-backup>\frontend-dist" "frontend\dist" /MIR
```

Depois reabre com `START.bat`. A `version.txt` do backend continua
de onde o update deixou — se ela te incomodar no rollback, apague
`backend\version.txt` (aí a versão volta a sair do `package.json`).

## Limites honestos (lidos antes de reclamar)

- **Modo dev (`npm run dev`, tsx) não carrega o dist atualizado** —
  o atualizador troca dist, e o dev roda do código-fonte. Depois de
  aplicar, use `START.bat` (produção).
- **Dependências**: o bundle não carrega `node_modules`. Se um
  release mexer em dependências (o changelog avisa), rode
  `npm install` na pasta do código antes do `START.bat`.
- Rascunhos (draft) **nunca** aparecem — API do GitHub não expõe.
- Trocar o intervalo do auto-check no painel só vale **após
  reiniciar o Geraldo** (o timer é criado no boot).
- Envio de erro do robocopy: se a cópia falhar sério (código ≥ 8)
  o helper avisa na janela e aponta os backups — nada é apagado
  antes do backup existir.

## Publicar um release novo (o outro lado do sistema)

No repo que o painel aponta (ex.: `guilhermdugrau-jpg/geraldo`):

1. Na raiz do projeto:
   ```
   npm run build
   ```
2. Monte o bundle:
   ```
   mkdir release-demo
   echo 0.2.0> release-demo\version.txt
   xcopy backend\dist release-demo\backend\ /E /I
   xcopy frontend\dist release-demo\frontend\ /E /I
   copy START.bat release-demo\
   ```
3. Compacte a **pasta `release-demo`** em `geraldo-0.2.0.zip`
   (os três itens na raiz do zip).
4. Gere o checksum (opcional, mas recomendado — atenção: o
   `>` do PowerShell 5.1 grava em UTF-16, então use WriteAllText,
   que grava texto que o Geraldo consegue ler):
   ```
   powershell -c "[IO.File]::WriteAllText('geraldo-0.2.0.zip.sha256', (Get-FileHash geraldo-0.2.0.zip -A SHA256).Hash.ToLower() + '  geraldo-0.2.0.zip' + [Environment]::NewLine)"
   ```
5. Publique:
   ```
   gh release create v0.2.0 geraldo-0.2.0.zip geraldo-0.2.0.zip.sha256 ^
     --title "Geraldo 0.2.0" --notes "..."
   ```
   Marcar como **pré-release** faz o pacote valer pros canais
   `beta`/`development` e não pra `stable`.

O repo precisa estar **público** (o atualizador lê anônimo) e o
`.zip` + `.sha256` anexados como assets do release.

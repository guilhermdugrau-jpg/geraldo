# PROGRESS — Geraldo AI

> Lembrete operacional registrado pelo engenheiro: **na hora de configurar
> push do auto-update (ETAPA 9), solicitar ao Lucas um token de acesso
> pessoal do GitHub** (o token antigo embutido no remote do NovaBot era
> exposto e deve ser revogado).

## Diagnóstico do ambiente (03/11/2026)

- Windows 10 IoT Enterprise LTSC 2021, AMD64
- Intel i5-2400 (4C/4T, 3.1GHz), 16 GB DDR3, Radeon HD 5450 (fraca p/ IA)
- Node v24.22.1, npm 11.19.1, git 2.56.0
- Existente: `Documents\NovaBot` (Electron+Baileys, JS, dashboard embutida,
  updater próprio) — **mantido intacto para referência**; `Downloads\l\
  NovaBot-WhatsApp-2.3.9` (Node puro) — não usado como base
- Decisão do usuário: **novo projeto** em `Documents\Geraldo` na arquitetura
  do prompt mestre (backend TS + React/Vite, sem Electron)

## Contratos do usuário

1. **Nunca apagar progresso existente** ✓ (NovaBot preservado)
2. **Token GitHub** → solicitado ao usuário no momento do push (ETAPA 9)

## ETAPA 1 — Fundação ✔ concluída

- [x] Estrutura de pastas backend/frontend (sem pastas vazias)
- [x] Backend TypeScript (NodeNext/ESM): boot, config store, saída de dados
      em `%APPDATA%\Geraldo` (overridable por `GERALDO_DATA_DIR`)
- [x] Logger: níveis, cores em TTY, JSONL em `data/logs/`, buffer circular
      compartilhado com o painel
- [x] SQLite via `node:sqlite` (zero dependência nativa — bom p/ hardware
      modesto), WAL, prepared statements
- [x] Migrações versionadas e idempotentes (001: conversations, messages,
      tasks, settings, media_files, migrations), teste cobre idempotência
- [x] Segurança: senha scrypt + token HMAC-SHA256 expirável, rate limit
      global e login, entrada validada com Zod, API key mascarada nas
      respostas e nunca logada
- [x] API REST `/api` (health, auth/login, auth/me, system/status,
      settings GET/PUT, security/password, logs)
- [x] Socket.IO: autenticação do handshake com o token, eventos `logs`,
      `log`, `status` (5 s) e `settings`
- [x] Frontend React+Vite: Login, Visão geral, Logs (filtros/exportação
      real), Configurações (IA + trocar senha + preferências), estados
      honestos para módulos futuros (ETAPA n), sem botões falsos
- [x] `npm install` / `npm run dev` / `npm run build` / `npm start` /
      `npm run test` funcionando (workspaces npm)

### Validações executadas (não é "decoreba")

- `npm run typecheck` (backend + frontend, strict) ✓
- `npm run test` — 32 testes (node:test + tsx) passando, incluindo smoke
  da API REST com login real, troca de senha e máscara de API key ✓
- `npm run build` (tsc backend + vite frontend: payload 73 KB gzip) ✓
- Boot real `node backend/dist/index.js` (produção): `/api/health`,
  GET `/` servindo `frontend/dist`, fallback SPA em `/login`, 401 em
  rotas API desconhecidas ✓ v0.1.0 lida de `backend/package.json` ✓

## ETAPA 2 — WhatsApp ✔ concluída

Implementado (tudo funcionando de verdade, sem gambiarra):

- **Dependências**: `@whiskeysockets/baileys@^6.7.21` (resolvida 6.7.24 —
  estável; a 7.0.0-rc14 foi descartada por ser RC), `qrcode`, `pino`
  (logger silencioso do Baileys), `@hapi/boom` (códigos de desconexão).
- **`whatsappService`**: conexão via `useMultiFileAuthState` com sessão em
  `dataDir/whatsapp-session/` (sobrevive update), QR convertido a dataURL
  (o `printQRInTerminal` está deprecado), `markOnlineOnConnect: false`,
  `Browsers.ubuntu('Geraldo AI')`, versão do protocolo atualizada via
  `fetchLatestBaileysVersion` com fallback offline.
- **Estados** (`off|connecting|qr|connected|disconnected|logged_out`)
  transmitidos ao painel por `whatsapp:status` + `whatsapp:qr` (Socket.IO,
  autenticado). Reconexão automática com backoff (2s → 60s cap);
  401 = logout (não reconecta), 440 = sessão substituída (para).
  Desconexão manual não tenta reconectar (flag `suppressReconnect`).
- **Boot**: se existe sessão salva (`creds.json`), o Geraldo conecta
  sozinho ao subir. `destroySession` apaga a pasta (e a sessão).
- **Recepção (`extract.ts`)**: extrai text/extendedText/imagem/áudio/vídeo/
  documento/sticker, caption como corpo, menção por Jid (+ device-suffix
  normalizado), menção textual `@geraldo`, resposta à mensagem do bot,
  `pushName`, timestamp protobuf Long → ISO, corpo truncado a 4000.
  Reações/protocolo são descartados.
- **Persistência**: migração **002** (`messages.wamid` + índice único
  parcial com backup do banco antes da alteração); `ensureConversation`
  idempotente (COALESCE título), `saveMessage` idempotente por `wamid`
  (reentregas não duplicam), `listChats` (busca por Jid/título/última
  mensagem, ordena por atividade), `listMessages` cronologicamente
  crescente, `memory_enabled` por conversa.
- **Política de resposta (honesta, sem IA — espera ETAPA 3)**: em grupo
  responde só a menção/resposta (por hora nada, registra e aguarda);
  em privado manda UMA saudação nordestina por conversa (se o toggle
  `respondInPrivate` estiver ligado — Configurações). Sem botões falsos.
- **API**: `GET /whatsapp/status`, `POST /whatsapp/connect`,
  `POST /whatsapp/disconnect`, `DELETE /whatsapp/session`,
  `GET /whatsapp/conversations?search=`, `GET /whatsapp/conversations/:jid/messages`,
  `PUT /whatsapp/conversations/:jid/memory`, `POST /whatsapp/conversations/:jid/message`
  (envio manual pelo painel — mensagem registrada como `out`).
- **Painel**: página **WhatsApp** (estado, QR em imagem, conecta/
  desconecta, apagar sessão com confirm REAL), página **Conversas**
  (busca, histórico real do SQLite, toggle de memória por conversa,
  envio manual), toggle "Responder no privado" em Configurações.
  Nav sem tags E2/E3 (páginas reais agora).

### Validações executadas (ETAPA 2)

- `npm run typecheck` backend+frontend ✓
- `npm run test` — **63 testes** (32 anteriores + 31 novos: extract,
  connectionPolicy, store) ✓
- `npm run build` (tsc + vite: 234 KB / 75 KB gzip) ✓
- Boot produção com `GERALDO_DATA_DIR` temporário: migrações `1, 2`
  aplicadas + backup `db-pre-m2-*.sqlite.bak` gerado ✓
- API real: health OK; login → `/whatsapp/status` (state=off,
  `hasSession=false`); `conversations` vazia; PUT `respondInPrivate`
  persiste em `config.json` e volta pelos settings ✓; rota sem token → 401 ✓
- QR, conexão e recepção ao vivo: requer o celular do Lucas (procedimento
  completo vai para o README quando a fase ficar redonda).

## ETAPA 3 — AIEngine ✔ concluída (inclui validação com chave real)

Implementado (protocolo OpenAI-compat testado por mock fiel; tudo
passando por typecheck, unit e smoke e2e de verdade):

- **`ai/client.ts`**: cliente compatível OpenAI (`/chat/completions`)
  que serve os provedores Groq, Google AI Studio (`.../v1beta/openai`),
  Z.ai (`/api/paas/v4`), OpenRouter, Ollama e qualquer API OpenAI.
  Suporta `stream: true` (SSE: acumula `choices[0].delta.content` até
  `data: [DONE]`), fallback JSON quando o provedor responde JSON mesmo
  pedindo stream, timeout honesto via AbortController (1s..600s) e
  `Authorization: Bearer` **só** quando há apiKey (Ollama local não manda).
- **`ai/prompt.ts`**: system prompt com personalidade nordestina, regra
  anti-vazamento e instruções para grupos; transcript com `Geraldo:`/
  `[nome]` respeitando `memory_enabled` por conversa; histórico truncado
  (DEFAULT_HISTORY_TURNS=12); `FAILURE_REPLY` honesto quando a IA cai.
- **`ai/aiEngine.ts`**: orquestrador — `canGenerate`, lock por conversa
  (`pendingChats`), racionamento (SlidingRateLimiter 30/min), resposta
  citando a mensagem original, fallback para `fallbackModel` quando o
  modelo principal dá erro (429/503/timeout), apiKey pass-through para
  qualquer provedor; `testGenerate` (botão real do painel, sem stream,
  maxTokens ≤ 256).
- **Integração com WhatsApp**: `whatsappService` chama `ai.respond(...)`
  quando a IA está configurada (senão mantém a saudação fixa da ETAPA 2);
  envio real via `bindSend` → `whatsappService.sendText`.
- **API**: `POST /api/ai/test` (Zod, prompt ≤ 2000 chars) e
  `GET /api/settings/ai-presets` (presets públicos, sem segredos).
- **Presets de provedores** (pesquisa em docs oficiais, nov/2026;
  fonte única em `ai/presets.ts`): **Groq** 1º — `openai/gpt-oss-120b`
  (fallback `qwen/qwen3.8-27b`), grátis permanente sem cartão
  (30 RPM / ~1.000 RPD / 8K TPM / 200K TPD), Tool Use + JSON mode +
  reasoning + streaming confirmados na doc do modelo; **Google AI
  Studio/Gemini** — `gemini-3.8-flash` (5 RPM/20 RPD gratis) com
  fallback `3.5-flash-lite` (~500 RPD) num endpoint OpenAI-compat
  oficial; **Z.ai GLM Flash** — linha GLM $0 permanente
  (`glm-4.7-flash`, fallback `4.5-flash`); **OpenRouter** — agregador
  com `z-ai/glm-5.3-flash-free` **preservado** (pedido do Lucas; free
  20 RPM/50 RPD, 1.000/dia após US$10 único); **Ollama** local e API
  OpenAI compatível. `config.ai.provider` estendido para
  `disabled|openai|ollama|groq|gemini|zai|openrouter` (default segue
  `disabled`). Cerebras (cartão obrigatório), Mistral (sem free tier
  publicado) e GitHub Models (retirado 30/07/2026) descartados com
  fundamento documentado.
- **Painel**: Configurações com "Preset rápido" (aplica provider/URL/
  modelo/fallback de uma vez e avisa quando precisa API key) + botão
  **Testar IA (chamada real)** mostrando resposta ou erro honesto.

### Validações executadas (ETAPA 3)

- `npm run typecheck` backend+frontend ✓
- `npm run test` — **104 testes** (63 anteriores + 41 novos: client,
  engine, limiter, prompt e presets) ✓
- `npm run build` backend (tsc) + frontend (vite: 236 KB / 76 KB gzip) ✓
- Smoke e2e em produção (backend real + **mock fiel OpenAI-compat** na
  porta 4890 exigindo Bearer): `GET /settings/ai-presets` devolve os 7
  presets ✓; PUT settings com `provider=groq`, `baseUrl` do mock e
  apiKey fake → resposta **mascarada** (`********`), `canGenerate=true`
  ✓; `POST /ai/test` → `ok:true, reply "replica do mock e2e"` provando o
  circuito fastify→engine→client→Bearer ✓; chave real só no
  `config.json` local (design atual) e **zero ocorrências em logs**
  (grep nos logs do backend e do mock) ✓
- Streaming, 429, timeout e fallback de modelo cobertos por unit tests
  com mock fiel do protocolo. **Validação com a API REAL concluída** (
  04/11/2026, key Groq fornecida pelo Lucas em memória, ambiente
  temporário, apagado ao fim; zero `gsk_` no código e nos logs):
  `POST /api/ai/test` com provider `groq`, `openai/gpt-oss-120b` →
  `ok:true` — resposta nordestina real do modelo ✓ e streaming SSE
  real (parser do Geraldo contra o `text/event-stream` do Groq)
  → "Oxente, deu bão, streaming tá no ponto, visse!" em 1.3 s ✓
- **Descoberta do teste real (doc interna vale ouro)**: no Groq, o
  `gpt-oss-120b` em stream manda o raciocínio em `delta.reasoning`
  (166 eventos, 652 chars) ANTES do `delta.content` (9 eventos);
   com `max_tokens` baixo (80) o orçamento morre no reasoning e o
   client fica sem content ("stream terminou sem conteúdo" honesto).
   Com o teto padrão (512 tokens) reasoning + content cabem de sobra.
   Pendência futura listada: suporte a `reasoning_effort`/confinar
   orçamento de raciocínio para models reasoning.

## ETAPA 4 — MediaEngine + fila de downloads ✔ concluída

Fila persistente de downloads com yt-dlp + FFmpeg, catálogo de mídias
e página "Downloads" no painel. Máquina alvo (i5-2400): concorrência 1
e limites conservadores.

- **`media/progress.ts`**: parser puro das linhas `--newline` do
  yt-dlp (download %/velocidade/tamanho, convert, error, info) e
  `mimeForExtension`. Sem I/O — só mapeamento.
- **`media/tools.ts`**: resolução de ferramentas com fallback em
  cascata: override (config/env `GERALDO_YTDLP`/`GERALDO_FFMPEG`) →
  nome nu no PATH (`where`) → caminhos conhecidos do winget
  (`%LOCALAPPDATA%\Microsoft\WinGet\Packages\...`). Cada candidato é
  probeado rodando o binário de verdade; yt-dlp com `--version` e
  **ffmpeg com `-version` (descoberta: ffmpeg não aceita `--version` —
  sai com exit code lixo sem imprimir nada; pego por probe real)**
  e retorna versões honestas o vazio.
- **`media/runner.ts`** (TaskRunner): fila em SQLite (tabela `tasks`,
  já na migração 001 — sem migração nova). Concorrência 1, handlers
  por `type`, `enqueue/cancel/get/list/counts`. Persistência: `queued`
  sobrevive reinício e é re-executado no boot (bounce: running antiga
  virá `canceled` com nota "interrompido pelo reinício", queued volta
  pra fila). Eventos `job:progress`/`job:done` para o painel via
  bridge. Payload vive em `tasks.detail` (JSON) — texto de etapa é
  só evento, não sobrescreve o payload.
- **`media/mediaEngine.ts`** (MediaEngine): handler `media_download`
  registrando no runner. Regras de entrada: URL http(s) única (sem
  playlist), formato `audio`/`video`. Comando: `yt-dlp --newline
  --progress --ffmpeg-location <dir> --no-playlist --no-warnings
  --max-filesize 500M` e áudio → `-f bestaudio/best -x --audio-format
  mp3 --audio-quality 192K`; vídeo → `-f "bestvideo[ext=mp4]+bestaudio
  [ext=m4a]/bestvideo+bestaudio/best" --remux-video mp4`. Saída em
  `mkdtemp` e depois movida para `paths.mediaDir` com nome
  `YYYY-MM-DD-HHMMSS-<rand>.ext`; linha em `media_files` (id, chat,
  category, source_url, file_path, mime, bytes, created_at).
  Progresso: download mapeia 0→0.85, conversão 0.92, ficha 1.0 com
  tamanho final. Falha honesta com as últimas linhas do stderr e
  código de saída; ferramentas faltando → erro com orientação
  ("winget install yt-dlp.yt-dlp"). Detecção de ferramentas feita
  cache-first no boot (boot valida versões; o job usa o cache e só
  re-detecta com força se estiver vazio).
- **API** `media/*` autenticada: `GET /media/tools` (ready + versões
  + hint de winget), `POST /media/download` (Zod url 8..600 + format;
  400/202 com jobId), `GET /media/jobs[/:id]`, `POST /media/jobs/:id/
  cancel` (409 quando fora da fila), `GET /media/files` e
  `GET /media/files/:id/file` (`res.download` com guard `mediaDir` +
  410 quando o arquivo sumiu do disco). Visibilidade honesto no
  `system/status`: contadores reais da fila.
- **Painel**: página **Downloads** (`pages/Downloads.tsx`) no menu:
  fila ao vivo por Socket.IO (`media:progress`/`media:done`), barra de
  progresso real, cancelar job ativo, histórico de encerrados com
  erro/status, catálogo com "salvar" baixando por fetch com Bearer
  (blob → `<a download>`) e badge honesta de ferramentas com hint de
  instalação.
- **Testes**: 26 novos (total **130**, todos verdes): parser de
  progresso, runner (fila/persistência/cancel/resume/boot), engine
  com spawn fake injetável (happy path mp3/mp4, catálogo, falha real
  do yt-dlp, regras 400, cache de toolsStatus, flags do spawn) e
  smoke das rotas `/media/*` com fila real sem ferramentas (erros
  honestos).

### Validações executadas (ETAPA 4)

- `npm run typecheck` + `npm run build` backend/front ✓; `npm run
  test` **130/130** ✓ (regressão registrada: `ffmpeg --version`
  (duplo hífen) fecha com exit code alucinógeno e sem saída — probe
  usa `-version`).
- Smoke em produção com dados temporários: instalação real de
  **yt-dlp 2026.10.26 + yt-dlp.FFmpeg (winget)**; boot acha as duas
  ferramentas e loga versões; `GET /media/tools` → `ready:true` com
  versões reais ✓
- **Download real pela fila**: POST `/media/download` (MP3 direto,
  sample-3s) → job `queued→running` com progresso ao vivo (1%, 85%,
  **`done` em ~12 s**) → `media_files` catalogado (51 KB,
  `audio/mpeg`) → arquivo entregue pelo painel com os mesmos 51 KB e
  **ffprobe confere MP3 de 3,19 s** ✓; log real: "download pronto:
  2026-11-05-01-18-13-6c6984.mp3 (51 KB)" ✓
- Fila persistente: job enfileirado sem ferramentas → `failed` com
  mensagem honesta; boot com `running` fantasma → `canceled`
  documentado por teste ✓

## ETAPA 5 — Memes & Sons (MyInstants) ✔ concluída

Sons "instant" do MyInstants: busca, catálogo e envio como áudio no
WhatsApp. Sem API oficial — o Geraldo raspa a página de busca pública
com etiqueta (User-Agent manifesto, intervalo mínimo de 3 s entre
requisições, robots.txt respeitado) e erro honesto quando o site
bloqueia ou muda o layout — nunca lista inventada.

- **`search/instants.ts`** (SearchEngine): fetch da página
  `/en/search/?name=` com timeout 12 s; parser puro do markup real
  (nov/2026): blocos `<div class="instant">` → primeiro
  `play('URL', 'loader-i', 'id')` → URL relativa resolvida pra https
  absoluto + título do `<a class="instant-link ...">texto</a>`.
  **Duas descobertas cravadas do markup vivo**: (1) cortar o bloco na
  primeira `</div>` perde tudo, porque o círculo de fundo fecha
  antes do botão — o bloco tem que ir até o próximo
  `<div class="instant"`; (2) o `<a>` carrega classes extras
  (`instant-link link-secondary`) — regex exige `class="[^"]*instant-link..."
  senão o título cai no fallback do nome do arquivo. `PolitenessGate`
  (3.000 ms) unifica busca e importação: recusa com `waitMs` (rota
  vira 429 honesta).
- **`media/memeEngine.ts`** (MemeEngine): `search()` (gate → engine),
  `importSound()` — URL tem que ser https `*.myinstants.com` +
  `/media/sounds/` (nada de proxy pra endereço estranho), download
  com UA manifesto + timeout 45 s + teto de 20 MB, arquivo em
  `paths.mediaDir` com nome legível (`som-<slug>-<stamp>.mp3`) e
  linha em `media_files` (categoria `sound`); `listSounds/getSound`
  (título reconstruído do nome do arquivo — o banco não guarda
  title); `send()` valida som/jid e delega ao WhatsApp; `remove()` só
  som. `fetchBytes` injetável (testes sem rede).
- **`whatsappService.sendAudio`**: `sendMessage` com `{ audio, mimetype,
  ptt: false }`, mimetype pelo `mimeForExtension`, registro `out` na
  conversa com `wamid` real, erro honesto "WhatsApp não está
  conectado" (rotas mapeiam 409).
- **API `/memes/*`** autenticada: `GET /search?q=` (429 com waitMs no
  gate), `POST /import` (title+url; 201 com id), `GET /sounds` e
  `POST /send {soundId, jid}` (409 desconectado / 404 som sumido /
  400 jid inválido — mapeamento por conteúdo honesto).
- **Painel**: página **Memes** (`pages/Memes.tsx`) no menu: busca com
  note de limites, resultados com preview `<audio src>` direto do CDN
  do site, botão "importar", chat de destino na lista (via
  `/whatsapp/conversations`) + estado do WhatsApp ao vivo (evento
  `whatsapp:status`), catálogo "Meus sons" com "ouvir" (blob +
  Bearer) e "mandar" (desabilitado honesto até conectar).
- **Testes**: 10 novos (total **140**): parser (título/texto,
  entidades, dedupe, URL relativa), gate, wrapper de busca (HTTP 403
  → erro honesto, corte de query >80), rotas `/memes/*` com engine
  fake (429 de gate, import no catálogo, 409 de envio).

### Validações executadas (ETAPA 5)

- `npm run typecheck` backend+frontend ✓; builds green; `npm run
  test` **140/140** ✓
- **Busca real** "vine boom" contra o MyInstants de verdade:
  `GET /memes/search` → 12 hits com títulos reais ("VINE BOOM SOUND",
  "BRUH sound effect!", …) e URLs `/media/sounds/*.mp3` ✓ (os dois
  consertos de parser acima saíram DA comparação com o HTML vivo)
- **Import real**: POST `/memes/import` do `vine-boom.mp3` → id
  catalogado; ffprobe no arquivo importado: `format_name=mp3,
  duration=1.25 s` (21 KB) ✓
- **Envio sem WhatsApp conectado → 409** com `{"error":"WhatsApp não
  está conectado"}` (comportamento honesto — o envio efetivo exige o
  QR do Lucas, fica pro procedimento de teste manual com o celular)
- Politeness no mundo real: 3 s entre buscas e imports; o smoke fez
  4 requisições seguidas de forma educada, zero bloqueio do site ✓



## ETAPA 6 — Voz (Piper TTS local) ✔ concluída

Texto → fala **sem nuvem**: o Piper TTS (VITS/ONNX) roda como
executável local e a saída sai como nota de voz (OGG/Opus) no
WhatsApp. A máquina (i5-2400) sintetiza ~7× mais rápido que tempo real
(RTF 0.15 medido de verdade), então uma síntese por vez basta.

### Pesquisa e escolha de ativos (linkados, revisados em 05/11/2026)

- Repositório original `rhasspy/piper` foi **arquivado em out/2025**
  (README só diz "moved" → fork vivo `OHF-Voice/piper1-gpl`); a
  release binária usável continua oficial: **`2023.11.14-2`**
  ("Latest" da própria archive) →
  `piper_windows_amd64.zip` (22.477.236 bytes, confirmado no
  download), com `piper.exe` 1.2.0 + `espeak-ng-data` do lado.
- Vozes pt_BR no Hugging Face `rhasspy/piper-voices` (main): 4 vozes
  ~63 MB cada — **`pt_BR-faber-medium` (63.201.294 bytes, batendo
  byte a byte com o HF; escolhida como default do botão de
  instalação)**, `-cadu-medium`, `-jeff-medium`, `-edresson-low`,
  sempre em par `.onnx` + `.onnx.json`.
- CLI confirmado na máquina: `piper --version` → `1.2.0`; opções
  `-m/--model`, `-c/--config`, `-f/--output_file`, `-d/--output_dir`,
  `--output_raw`, `-s/--speaker`, `--noise_scale/--length_scale/
  --noise_w`; texto entra por **stdin**. Pipeline escolhido:
  texto (stdin) → piper → WAV 22 050 Hz mono → ffmpeg
  (`-c:a libopus -b:a 48k -ar 16000 -ac 1`) → OGG/Opus (formato de
  nota de voz do WhatsApp; o ffprobe mostra 48 kHz porque é o
  padrão do stream Opus, conversão interna, honesto e correto).
- Medição real de síntese (prova isolada antes de codar):
  "Axente Geraldo, tudo certo, cabra da peste?" → WAV 132.768 bytes
  (pcm_s16le 22050 mono, 3,01 s), `Real-time factor: 0.15`
  (inferência 0,42 s); ffmpeg → OGG Opus 16.385 bytes (3,02 s).

### Implementação

- **`config/paths.ts`**: `ResolvedPaths` ganha `piperDir` e
  `voicesDir` (dados longe do código: `<dataDir>/piper` e
  `<dataDir>/voices`; override honesto por env `GERALDO_PIPER`).
- **`voice/tools.ts`**: resolver de binário (env → layout instalado
  `<piperDir>/piper/piper.exe` → PATH) com probe real `--version`
  (spawn com timeout; **catch de `EFTYPE` — Windows lança
  sincronamente quando o caminho aponta pra arquivo
  não-executável**, achado por teste); `listVoiceFiles` aceita só
  `.onnx` com `.onnx.json` do lado (órfão é ignorado); mapa das 4
  vozes pt_BR com URLs de resolve do HF (`pingFileUrls`) e
  `piperZipUrl()` do release; hints em PT-BR de tudo que falta.
- **`voice/voiceEngine.ts`** (VoiceEngine): `status()` (ready =
  piper presente + ≥1 voz), `installAssets(voiceId)` — baixa o zip
  (teto 120 MB, `.part` + rename) e extrai com **`tar.exe`**
  (bsdtar lê zip no Windows 10+, zero dependência nova), depois a
  voz (par onnx/json, sanidade ≥10 MB); `synthesize()` — texto
  validado (1–400 chars, trim), **cache por sha256(voiceId::text)
  (primeiros 24 hex → id de clip)**, **lock: uma síntese por vez**
  (segunda chamada → erro "já sintetizando" → 409 na rota),
  tmp `voice-*` limpo após sucesso, run do piper **injetável**
  (`synthRun`) e conversão ffmpeg **injetável** (`convertAudio`) —
  testes unitários rodando sem piper/ffmpeg reais; INSERT em
  `media_files` categoria `voice`, mime `audio/ogg`; `listClips`
  /`getClip`; `send()` valida clip existente + arquivo no disco +
  jid e manda via `sendVoiceNote`. Pedido de voz **não instalada é
  erro honesto** (o teste pegou um fallback silencioso pra primeira
  voz — comportamento desonesto que eu mesmo tinha escrito;
  corrigido).
- **`whatsappService.sendVoiceNote`**: `sendMessage` com
  `{ audio, mimetype: 'audio/ogg; codecs=opus', ptt: true }`
  (nota de voz de verdade, não áudio comum), registro `out` com
  `wamid` real, erro honesto "WhatsApp não está conectado" (rotas
  mapeiam 409).
- **API `/voice/*`** autenticada: `GET /status` (estado + hints),
  `POST /install {voiceId?}` (default faber), `POST /synthesize
  {text, voiceId?}` (**201** com `{id, voice, cached}`; 409 lock;
  400 textos/vozes; zod cobre max 400), `GET /clips`, `POST /send
  {clipId, jid}` (409 desconectado / 404 clip sumido / 400 jid).
- **Wiring**: `index.ts` cria o VoiceEngine (ffmpeg via resolver do
  MediaEngine) e loga no boot "voz pronta: piper 1.2.0 · N voz(es)"
  ou o hint honesto do que falta.
- **Painel**: página **Voz** no menu (ícone 🎙): badges honestas
  (piper/versão, vozes, pronto), botão instalar (~85 MB na primeira
  vez, desabilitado quando já pronto), formulário de fala (select de
  voz + textarea com contador 400), catálogo de clips com "ouvir"
  (blob + Bearer, mesmo técnica das mídias) e "mandar" como **nota
  de voz** (desabilitado honesto até conectar; estado vivo via
  `whatsapp:status`). Helper de blob extraído pra
  `services/media.ts` (única fonte, também usada pelo Memes).
- **Testes**: 15 novos (total **155**): engine com peças injetadas
  (status honesto, síntese feliz + catálogo + tmp eliminado, cache
  sem re-run, **lock real**, erros instrutivos de texto/voz/piper/
  ffmpeg, envios fantasma/sumido/jid inválido/feliz) e tools resolvers.

### Validações executadas (ETAPA 6)

- `npm run typecheck` backend+frontend ✓; `npm run build` ✓;
  `npm run test` **155/155** ✓ (consertos do dia: EFTYPE no probe,
  fallback de voz desonesto, ordem no teste de envio).
- **Smoke em produção** (backend real na porta 4820, dados
  temporários em `Temp\opencode\smoke-etapa6`, piper+voz copiados
  pra dentro — honesto, sem atalho de variável): boot loga
  "voz pronta: piper 1.2.0 · 1 voz(es) pt_BR" ✓; login
  `/api/auth/login` ✓; `GET /voice/status` → `ready:true`, faber
  63.201.294 bytes ✓; `POST /voice/synthesize` → **201** com clip
  gerado de verdade — **ffprobe no arquivo: `opus, mono, ogg, 4,96 s,
  27.042 bytes`** ✓; mesma frase de novo → **`cached:true`** com o
  mesmo id (sem re-run do piper) ✓; texto com 401+ chars → **400**
  do zod ✓; **duas sínteses em paralelo → 409** "voz já
  sintetizando" na segunda ✓; `POST /voice/send` com o clip real
  e WhatsApp desconectado → **409** `{"error":"WhatsApp não está
  conectado"}` ✓ (envio efetivo exige o QR do Lucas — mesma nota da
  ETAPA 5: procedimento manual quando ele quiser testar com o
  celular).
- Áudio ouvido da síntese isolada (prova de fumo): fala em PT-BR
  clara com a voz faber ✓.

## ETAPA 7 — Imagens e vídeos ✔ concluída

**Gerar imagem por prompt** no provedor de IA configurado e mandar
**arquivos do catálogo** (vídeo mp4, áudio, imagem) direto no WhatsApp.
"Vídeos" aqui = **enviar o mp4 baixado pelo yt-dlp** (geração de vídeo
excluída de propósito: CogVideoX custa ~US$ 0,20/trecho e o pedido do
Geraldo DJ não depende disso — ficou marcada como limitação honesta).

### Pesquisa e escolha de provedores (05/11/2026)

O Geraldo usa **a mesma chave de IA que já conversa** — imagem só nos
provedores que expõem endpoint de imagem:

- **Z.ai (default quando disponível)** — `POST {baseUrl}/api/paas/v4/
  images/generations` com Bearer: `{model:'glm-image', prompt, size:'1280x1280',
  quality:'standard'}` → `data[0].url` é **URL temporária (expira em 30
  dias)** → o Geraldo **baixa a imagem na hora** pro dataDir (o
  provedor apagar o arquivo depois não importa). Custo oficial:
  **US$ 0,015/imagem** standard (5–10 s; HD ~20 s custa mais) —
  consumido da chave do usuário. Fonte: `docs.z.ai/llms.txt`.
- **Google Gemini** — `POST
  https://generativelanguage.googleapis.com/v1beta/interactions`
  (headers `x-goog-api-key` + `Api-Revision: 2026-05-20`), body
  `input:[{type:'text',text}]` → imagem em `output_image.data`
  (base64). Modelo default **`gemini-nano-banana-2.1`**; cota grátis
  varia por tier — estouro de cota vira erro honesto, não retry cego.
- **Gateway OpenAI-compat** — `POST {baseUrl}/images/generations` com
  o **modelo que o dono da chave configurar** (`ai.model`, fallback
  `gpt-image-1`); resposta aceita `b64_json` ou `url`.
- **groq / ollama / openrouter** — **não expõem geração de imagem**
  (não à data da pesquisa): o painel diz isso direto (`capable:false`
  + hint apontando pra zai/gemini/openai) em vez de fingir.

### Design e implementação

- **`database/migrations.ts`**: migração **`003-imagens-etapa7`** →
  tabela `image_meta` (id = FK em `media_files.id`, prompt, provider,
  model, size, created_at). O arquivo continua no catálogo
  `media_files` categoria `image` — a meta é a parte "gerada por IA".
- **`images/providers.ts`**: adapters puros (zai/gemini/openai) +
  extratores de payload (URL Z.ai; `output_image`/`inlineData`
  aninhado Gemini; `b64_json`/`url` OpenAI) + **`sniffImageMime`**
  (magic bytes: PNG/JPEG; `application/octet-stream` → **recusa
  honesta**, não grava imagem podre). `describeImageSupport()`
  devolve capable/hint/modelName por provedor — texto real, sem
  promessa.
- **`images/imageEngine.ts`** (ImageEngine): `status()` (ready =
  provedor capaz + chave presente), `generate(prompt, size?)` —
  entry valida (prompt 1–1000 chars **com trim**; size
  `LxH` em px, 512–2048 por lado **só do Z.ai**), **sem cache de
  propósito**: mesmo prompt gera imagem nova de verdade (o
  GLM-Image não é determinístico e cache de "igual" seria enganoso),
  **lock: uma geração por vez**
  (segunda chamada → "já sendo gerada" → 409 na rota), download de
  URL via `fetchBinary` injetável, sniff antes de gravar, INSERT
  media_files + image_meta; `listImages(limit)`/`getImage(id)`
  (JOIN com meta); `send(id, jid, caption)` valida catálogo + disco
  + jid e manda via `sendImage`. `fetchHttp`/`fetchBinary`
  **injetáveis** — testes unitários rodam sem rede.
- **`whatsappService`**: `sendImage` (png/jpeg/webp + legenda opc.)
  e `sendVideo` (**só `.mp4`** — o yt-dlp remuxa; outro container é
  erro instrutivo). Ambos registram `out` com `wamid` real e erram
  "WhatsApp não está conectado" (rotas mapeiam 409).
- **API `/images/*` + `/media/send`** autenticada: `GET /images/status`
  (payload com capable/ready/hint/modelName/costNote), `POST
  /images/generate {prompt, size?}` (**409 lock; 400 erros de
  entrada/provedor com o texto do provedor real**), `GET /images/list
  ?limit`, `POST /images/send {imageId, jid, caption?}` (409/404/400);
  `POST /media/send {fileId, jid, caption?}` — **dispatch por mime**
  do catálogo (vídeo mp4 / imagem / áudio; o que não serve é 400
  com explicação, não silêncio).
- **Wiring** (`index.ts`): ImageEngine com `getAI: () =>
  settings.effectiveAI()` — **mesma fonte do AIEngine** (o painel
  grava IA na tabela settings; ler `config.get().ai` direto ignoraria
  a config do painel — bug que só o smoke pegou, detalhado abaixo).
- **Painel**: página **Imagens** (ícone 🖼): badge de status +
  custo por imagem (quando o provedor informa), formulário de
  prompt (textarea ≤1000 com contador) com select de tamanho honesto
  ("só GLM-Image aceita; outros ignoram"), galeria em grid com
  **prévia por blob autenticado** (`services/media.ts`), chat de
  destino + legenda + "mandar"; a página **Downloads** ganhou "mandar"
  por arquivo mandável (mp4/áudio/imagem via `/media/send`).

### Validações executadas (ETAPA 7)

- `npm run typecheck` backend+frontend ✓; `npm run build` ✓;
  `npm run test` **174/174** ✓ (16 novos no `imageEngine.test.ts`:
  status honestos por provedor, paths zai/gemini/openai com fakes de
  HTTP, extratores puros, sniff, **lock real**, entrada podre,
  envios; +3 rotas no `apiSmoke.test.ts`; `migrate.test.ts` deixou
  de cravar contagem dura e agora usa o registro real `MIGRATIONS`
  — com `image_meta` exigida).
- **Bug pego pelo smoke** (suíte não pega wiring): engine lia
  `config.get().ai`; painel edita `settings` (overlay no banco) —
  com provedor setado no painel o status continuava "IA desabilitada".
  Consertado pra `settings.effectiveAI()` e re-validado end-to-end.
- **Smoke em produção** (backend real, dados temporários em
  `Temp\opencode\smoke-etapa7`): boot honesto duplo — sem config:
  "geração de imagem inativa: IA desabilitada…" + migrações "1, 2, 3"
  ✓; com `provider=zai` via API de settings: "imagem pronta:
  zai/glm-image" + "custo: US$ 0,015/imagem" ✓; `GET /images/status`
  nos dois estados ✓; `POST /images/generate` sem provedor → **400
  instrutivo** ✓; **geração com chave fake → o provedor REAL
  (api.z.ai) respondeu HTTP 401 e o Geraldo devolveu
  `provedor respondeu HTTP 401`** — caminho de rede de verdade
  exercitado, sem inventar sucesso ✓; `GET /images/list` → vazio ✓;
  `POST /images/send` e `/media/send` com id fantasma → **404
  honestos**. Corpos JSON pelo PowerShell precisam ir por arquivo
  (`--data-binary '@file'`) — quirk do inline braces, conhecido
  das etapas anteriores. A geração **com imagem real** por fim
  exige chave do Lucas: painel → Configurações → IA → provedor
  zai/gemini + chave.

## NOVO MÓDULO SOLICITADO — Geraldo DJ 🎧 (ETAPA 11)

Pedido do Lucas (04/11/2026) para integrar **depois** do restante.
Resumo do escopo consolidado:

### Pré-requisitos (dependências no cronograma)
- ETAPA 2 (WhatsAppService: eventos, grupos, menções)
- ETAPA 3 (AIEngine: interpretação em linguagem natural, personalidade)
- ETAPA 4 (MediaEngine + fila: download/MP3)
- ETAPA 5 (SearchEngine: fontes musicais)
- ETAPA 6 (VoiceEngine/áudio)

### Módulos novos previstos
MusicSearchEngine · MusicProviderManager · MusicDownloadService
(reusa MediaEngine) · PlaylistManager · DJSessionManager ·
AudioStreamService · CallIntegration · DJPermissionService —
persistência em SQLite (playlists por grupo, histórico, preferências).

### Etapas internas (A→H)
- **A** — Diagnóstico técnico de chamadas do WhatsApp com Baileys
  (provar ANTES de afirmar; sem simular conexão que não existe).
- **B** — Pesquisa musical (título/artista/trecho; versões; nunca inventar
  resultado). YouTube Data API / Spotify Web API / fontes autorizadas.
- **C** — Download/conversão reutilizando MediaEngine (link quando não
  permitido baixar; sem burlar DRM).
- **D** — Playlists e filas isoladas por grupo, persistentes.
- **E** — Página "Geraldo DJ" no dashboard (estado por Socket.IO, fila,
  volume, histórico, playlists, controles reais).
- **F** — Integração com chamadas somente se comprovadamente viável
  (senão: módulos independentes entregues e limitação documentada).
- **G** — Streaming Opus em tempo real, se viável (baixo consumo no
  i5-2400: streaming em blocos, controle de concorrência).
- **H** — Testes (pesquisa, playlist, fila, permissões, isolamento entre
  grupos, desconexão/reconexão) + otimização + documentação.

### Regras duras do DJ
- Autorização/permissões antes de tocar ou entrar em chamada.
- Não travar o bot principal; fila de downloads com limite.
- Nunca vulnerabilizar a sessão (conta automatizada = risco conhecido).

## ETAPA 8 — Dashboard completo ✔ concluída

O master prompt original não está versionado no repo — o escopo aqui
deriva das **pendências que estavam marcadas explicitamente pra ETAPA
8** (CSP do build final, rotação de logs, revogação de token na troca
de senha) + do rótulo "Dashboard completo" do cronograma do README
(visão geral que responde de verdade "como tá o Geraldo hoje").

### O que achou de errado entrando nessa etapa (honesto)

- **`SystemStatusService.snapshot()` ainda cravava o WhatsApp como
  "Módulo chega na ETAPA 2"** — o card do painel mostrava
  "desconectado" sempre, mesmo com sessão conectada (o estado real
  só chegava por `whatsapp:status` nas abas específicas). Consertado:
  snapshot injeta `whatsappInfo()` do serviço vivo (redução
  honesta: `connected`/`qr`/else→`disconnected`).
- **Tokens do painel viviam até 12 h depois de trocar a senha**
  (o `changePassword` mantinha o mesmo `tokenSecret`). Consertado:
  risco junto da senha novo (`generateTokenSecret()`), persistido no
  config.json e aplicado via `updateSecrets`.

### Implementação

- **`services/statsService.ts`** (StatsService): `snapshot()` —
  contagens REAIS do banco por SQL de contagem: conversas (total +
  ativas 24 h), mensagens (total + 24 h), mídia por categoria
  (`media_files` com soma de bytes; vídeo sem bytes conta 0),
  tarefas (histórico por estado no `tasks` + fila viva do
  TaskRunner como fonte da verdade pra queued/running), estado do
  WhatsApp e IA (overlay efetivo, mesma fonte dos engines).
- **API `GET /api/stats`** autenticada — payload direto pro painel.
- **Painel (Overview)**: além dos cards de sempre (Estado, WhatsApp,
  IA, Recursos, Atividade), entraram **Conversas & mensagens**
  (total/24 h), **Mídia no botequim** (por categoria com rótulos em
  PT + bytes total, ordenado pelo maior) e **Tarefas** (merged: fila
  + histórico; nota honesta "fila ociosa" / "acompanhe na aba
  Downloads"). `/stats` dá fresco a cada 30 s (`setInterval`
  desmontado no unmount); com `/stats` indisponível os cards contam
  só com o snapshot (sem zero fake).
- **CSP de produção** (`httpApp.ts`): helmet com
  `default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data: blob:; media-src 'self' blob:;
  connect-src 'self' ws: wss:; font-src 'self';
  object-src 'none'; base-uri 'self';
  frame-ancestors 'none'; form-action 'self'`.
  `data:` cobre o favicon/QR base64; `blob:` cobre as prévias de
  mídia/imagens; `ws:`/`wss:` cobre Socket.IO (CSP3 é rígida com
  ws — `self` não cobre sempre na prática). **Ligada só quando o
  build do frontend é servido** — no dev o Vite injeta script
  inline, CSP continuaria fora (comentado no código).
- **Rotação de logs** (`logger/retention.ts`): `pruneOldLogFiles()`
  apaga só `app-AAAA-MM-DD.log` anteriores à janela (corte à
  meia-noite de hoje − 7 dias); **arquivo fora do padrão do Logger
  é intocado** (backup manual não é lixo); roda no boot + revisão
  por hora (`setInterval` com `unref()`, nunca segura o processo).
  Os 7 dias são constante de módulo (`LOG_KEEP_DAYS`) — configurável
  no código, não no painel (menos comandos mentais pro dono).
- **Revogação de token** (`index.ts` securityHooks): secret novo na
  troca, gerado com `randomBytes(32)`.

### Validações executadas (ETAPA 8)

- `npm run typecheck` backend+frontend ✓; `npm run build` ✓;
  `npm run test` **183/183** ✓ — 9 novos: 4 do StatsService (zeros
  honestos; semeadas com conversas/mensagens/mídia/tarefas e
  timestamps reais; fila viva manda em queued/running com resíduo
  velho no banco visto SOL — e o bug achado pelo próprio teste:
  branch de `running` tinha caído fora no rewrite), 3 da rotação
  (janela 7 dias com corte à meia-noite; `outro.backup.sqlite` e
  nome sem data ficam; `isKeepFile`), 2 no smoke da API (`GET
  /stats` zerado em banco limpo; CSP presente quando o painel é
  servido e ausente quando não há build — sem CSP forjada) + o
  teste de troca de senha agora prova a **revogação**: token
  emitido antes morre com 401 DEPOIS da troca e o re-login na senha
  nova vira token novo.
- **Smoke em produção** (porta 4820, dados em
  `Temp\opencode\smoke-etapa8`): log plantado de 1 ano atrás
  (`app-2025-09-01.log`) e backup manual do Lucas no log dir → boot
  logou **"rotação de logs: 1 arquivo(s) antigo(s) apagado(s)
  (> 7 dias)"** ✓ e no disco: velho **Apagado**, backup manual
  **Intocado** ✓; `GET /api/stats` → contagens reais zeradas com
  WhatsApp/IA honestos ✓; painel no build de prod → **CSP header
  exatamente projetada** no `/` e nos assets ✓; `PUT
  /security/password` → 200 ✓; `/auth/me` com o token velho →
  **401 "Sessão inválida ou expirada"** ✓ (revogação de verdade);
  login com a senha nova → token novo válido (200) ✓. Dados de
  smoke apagados no fim (limpeza combinada).
- **Confirmação visual do painel com CSP** ficou honesta pra Lucas:
  headers provado por `curl -I` e todos os recursos são
  self/data/blob (prévia por blob, QR por data:, WebSocket mesma
  origem) — se algo vacilar no browser, é caso para derrapar no
  log, não para desligar CSP.

## Pendências conhecidas

- Envio real no WhatsApp (nota de voz, som, imagem, vídeo, texto
  conversacional) depende do Lucas escanear o QR — instalação e
  sessão dele (todas as rotas já respondem honesto com 409 até lá).
- Geração de imagem de verdade (com arquivo no catálogo e foto no
  WhatsApp) depende do Lucas configurar provedor com chave paga no
  painel — Z.ai (US$ 0,015/imagem) ou Gemini/OpenAI-compat.
- Confirmação visual da CSP no navegador (clicar todas as abas com
  o build de prod): headers já provados no smoke; recursos são
  self/data/blob por projeto.
- Verificação da "fila viva" vs. banco (`snapshot()`) depois de
  uma queda com download em andamento: TaskRunner retoma pendentes
  no boot — comportamento já implementado, smoke de queda não executado.
- Overview usa polling de 30 s pra /stats (sem push de contagem) —
  design escolhido: contagem é barata em SQLite local.

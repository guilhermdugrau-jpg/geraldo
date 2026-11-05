# Arquitetura do Geraldo AI

## Visão macro

```
┌─────────────────────────┐        ┌── WhatsApp ── (ETAPA 2: Baileys)
│  Painel web (React +    │ Socket │
│  Vite, porta 3000)      ◄──────► │
└───────────▲─────────────┘        │   ┌────────────────┐
            │REST /api + ws        ▼   │ TaskManager    │ (ETAPA 4)
┌───────────┴───────────────────────────────────────┤  fila/progresso│
│              Backend (Node TS, porta 4820)        └────────────────┘
│  ┌─────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐
│  │ Security│ │ AIEngine │ │ MediaEng.  │ │ MemeEngine   │
│  │ (auth,  │ │ (ETAPA 3)│ │ (ETAPA 4)  │ │ (ETAPA 5)    │
│  │ limits) │ └──────────┘ └────────────┘ └──────────────┘
│  └─────────┘ ┌────────────┐ ┌─────────┐ ┌─────────────┐
│              │ VoiceEngine│ │Search   │ │ UpdateSvc   │
│              │ (ETAPA 6)  │ │(ETAPA 5)│ │ (ETAPA 9)   │
│              └────────────┘ └─────────┘ └─────────────┘
│      ┌─────────────────────────────┐
│      │ SQLite (node:sqlite) + WAL  │  ← dados em %APPDATA%\Geraldo
│      └─────────────────────────────┘
└────────────────────────────────────────────────────┘
```

## Princípios

1. **Backend e frontend separados.** Backend Express/Socket.IO na porta 4820;
   frontend Vite/React (dev) na 3000 com proxy. Em produção o backend serve
   o `dist/` do frontend.
2. **Nada do WhatsApp toca o sistema.** Mensagens são avaliadas pelas
   permissões dos módulos; nenhuma mensagem roda comando do SO.
3. **Dados longe do código.** Todo dado do usuário fica em
   `GERALDO_DATA_DIR` (padrão `%APPDATA%\Geraldo`), permitindo atualizar
   o código sem sobrescrever sessão, banco ou chaves (ETAPA 9).
4. **Máquina fraca primeiro.** SQLite síncrono (WAL), filas de tarefas,
   limite de concorrência, nenhum virtualizado/compilado pesado por padrão,
   IA preferencialmente externa ou Ollama pequena. Não exigimos GPU moderna.
5. **Progresso honesto.** Módulo que não existe entrega null/erro real —
   nunca mentimos que uma tarefa foi concluída.

## Backend

| Caminho | Papel |
|---|---|
| `backend/src/index.ts` | Boot: config → logger → banco/migrações → segurança → HTTP + Socket.IO |
| `config/` | `resolvePaths` (data dir), `ConfigStore` (JSON com defaults, nunca loga segredos) |
| `logger/` | Logger com níveis, cores em TTY, JSONL em `data/logs/`, buffer circular p/ painel |
| `database/` | `Database` (node:sqlite, prepared statements), `migrations/` (versionadas, idempotentes) + emails e backups automáticos |
| `security/` | `authService` (scrypt + token HMAC-SHA256), `middleware` (requireAuth, rate limit) |
| `services/` | `settingsService` (whitelist validada em DB), `systemStatus`, `taskRunner` (ETAPA 4) |
| `api/` | Rotas REST versionadas em `/api` |
| `ws/` | Socket.IO: auth por token, rooms `logs`, broadcast `status` |

## Frontend

| Caminho | Papel |
|---|---|
| `frontend/src/services/api.ts` | Fetch REST com token; redirect no 401 |
| `frontend/src/hooks/useSocket.ts` | Socket.IO com auth por token |
| `frontend/src/pages/` | Visão geral, Logs, Configurações (Restauradas por etapa) |
| `frontend/src/components/` | Card, Badge, Spinner, EmptyState |

## Banco de dados (migrações)

Tabelas de fundamentação (migração 001):

- `conversations` — por chat, com `memory_enabled` (privacidade)
- `messages` — log reversível por chat (in/out, texto/cry típica)
- `tasks` — fila de tarefas (ETAPA 4)
- `settings` — pares chave-valor (AI, personalidade e preferências)
- `media_files` — catálogo de mídia baixada (ETAPA 4)
- `migrations` — contagem de versão aplicada

## Segurança

Detalhada em `SECURITY.md`. Bases:

- Bind apenas em `127.0.0.1` (configurável de forma explícita)
- Dashboard com senha (scrypt) + token HMAC expirável
- Rate limit geral + limite duro no login
- Zod valida toda entrada mutável
- API keys ofuscadas nas respostas, nunca em logs
- Sem execução de comando via mensagem do WhatsApp, nunca

## Atualização (ETAPA 9)

- GitHub Releases ✓ visto por token de manifesto
- Update Service: comparação SemVer → download com SHA-256 → instalação
  em processo auxiliar → backup → reinício e rollback automático
- Ver `UPDATE_GUIDE.md`

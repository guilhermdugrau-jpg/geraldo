# Geraldo AI

Assistente nordestino inteligente para WhatsApp. Conecte sua conta escaneando
um QR Code (como no WhatsApp Web) e converse naturalmente com o Geraldo —
mentionando `@geraldo` em grupos ou falando direto nas conversas privadas.

Oxente, cabra! Ele entende linguagem natural, acha memes, baixa mídia
autorizada, gera imagens quando tem serviço disponível e conversa com
personalidade só do Nordeste.

> **Status atual: ETAPA 8 (Dashboard completo) concluída.** Veja `PROGRESS.md`
> para o estado exato do projeto.

## Requisitos

- Windows 10/11 (focado em máquinas modestas — testado em i5-2400, 16 GB)
- [Node.js 22+](https://nodejs.org) (recomendado 24 LTS)
- FFmpeg e yt-dlp (para downloads — são exigidos só a partir da ETAPA 4)

## Instalação e execução

1. Clone este projeto e acesse a pasta.
2. Dê dois cliques em `START.bat` **ou**:
   ```
   npm install
   npm run dev
   ```
3. Abra o painel: **http://localhost:3000**
4. Login inicial: usuário dashboard, senha **`geraldo123`**.
   **Troque a senha logo em Configurações.**
5. Para produção (backend compilado):
   ```
   npm run build
   npm start
   ```

## Onde ficam seus dados

Por padrão, no perfil de usuário:

```
%APPDATA%\Geraldo\
  config.json      <- configurações locais
  geraldo.db       <- banco SQLite (conversas, memória, fila)
  logs\            <- logs em JSONL
```

Nada de dados de usuário fica no diretório do código — isso permite
atualizações pelo GitHub (ETAPA 9) sem perder sessão, conversas ou chaves.

## Estrutura

```
Geraldo/
├── backend/          # API Node + TypeScript (Express, Socket.IO, SQLite)
├── frontend/         # Painel web React + Vite
├── docs/             # Guias
├── DESIGN/...        # (nada ainda — sem pastas vazias por estética)
├── START.bat
├── README.md,ARCHITECTURE.md,PROGRESS.md,SECURITY.md,UPDATE_GUIDE.md
```

Detalhes completos em `ARCHITECTURE.md`.

## Etapas do projeto

| Etapa | Módulo | Estado |
|---|---|---|
| 1 | Fundação (estrutura, backend/frontend, banco, config, logs, segurança) | Concluída |
| 2 | WhatsApp (QR Code, conexão, mensagens, menções) | Concluída |
| 3 | IA (personalidade nordestina, memória, provedores) | Concluída |
| 4 | Downloads (yt-dlp + FFmpeg, fila de tarefas) | Concluída |
| 5 | Memes/sons (MyInstants quando permitido) | Concluída |
| 6 | Voz (Piper TTS) | Concluída |
| 7 | Imagens e vídeos (geração por IA + envio de catálogo) | Concluída |
| 8 | Dashboard completo (visão geral + segurança: CSP, logs, sessões) | Concluída |
| 9 | Atualizador automático via GitHub | Pendente |
| 10 | Testes finais e otimização | Pendente |

## Sobre o WhatsApp

O Geraldo usa **Baileys**, uma implementação não-oficial do protocolo.
Podem existir instabilidade, quebras de protocolo e restrição da plataforma.
Este projeto **não** implementa mecanismos para burlar bloqueios ou limites.

## Licença

MIT.

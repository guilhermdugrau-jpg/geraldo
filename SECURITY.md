# Segurança — Geraldo AI

## Autenticação do dashboard

- Senha armazenada como `scrypt$salt$hash` (N=16384 via scryptSync padrão,
  64 bytes) no `config.json` local.
- Login: comparação em tempo constante (`timingSafeEqual`), atraso
  artificial de ~180 ms em falha para reduzir brute-force local.
- Sessão: token de 12 h assinado com HMAC-SHA256 usando segredo de 32 bytes
  gerado no primeiro boot. Nenhuma informação sensível no payload.
- Alterar a senha **não** invalida tokens já emitidos nesta versão
  (limitação registrada em `PROGRESS.md`).

## Limitação de requisições

- Limite geral: 600 req / 10 min por IP
- Limite no login: 10 req / 10 min por IP
- `express.json({ limit: '256kb' })`

## Segredos

- API keys ficam apenas em `settings` (SQLite local) ou `config.json` local;
  **nunca** vão para o repositório, **nunca** são logadas.
- Respostas da API **mascaram** API keys ( retornam `"********"` +
  flag `hasApiKey`).
- `.env` está no `.gitignore`. `.env.example` documenta as variáveis.

## Sassos externos

- Entradas de todo `PUT` validadas com Zod; chaves desconhecidas são
  descartadas (whitelist).
- Qualquer conteúdo que chega do WhatsApp é tratado como não confiável
  (ETAPA 3+). Nenhuma mensagem do WhatsApp executa comando do SO.
- SSRF: chamadas externas de futuros módulos (search, memes, API de IA)
  passam por validação de URL com permit-lists por provedor.

## Rede

- Backend por padrão escuta apenas `127.0.0.1`. Mudar isso é explícito
  (não recomendado sem rede confiável).
- Socket.IO exige o mesmo token do dashboard no handshake.

## Atualizações (ETAPA 9)

- Pacotes verificados por SHA-256 contra o manifesto; assinatura Ed25519
  quando o ambiente de build publicar a chave privada nos secrets.
- Instalação via processo auxiliar com backup automático e rollback.
- Jamais instaladores sem validação. Ver `UPDATE_GUIDE.md`.

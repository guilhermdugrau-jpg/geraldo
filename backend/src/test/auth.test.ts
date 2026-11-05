import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthService,
  generateTokenSecret,
  hashPassword,
  verifyPassword,
} from '../security/auth.ts';

const SECRET = generateTokenSecret();

function service(passwordHash: string | null = hashPassword('senha123'), ttlMs?: number) {
  return new AuthService({ tokenSecret: SECRET, passwordHash }, ttlMs);
}

test('hashPassword não armazena a senha e verify não engana', () => {
  const hash = hashPassword('bora-ver-cabra');
  assert.notEqual(hash, 'bora-ver-cabra');
  assert.ok(verifyPassword('bora-ver-cabra', hash));
  assert.equal(verifyPassword('errado', hash), false);
  assert.equal(verifyPassword('bora-ver-cabra', 'lixo'), false);
  assert.equal(verifyPassword('bora-ver-cabra', ''), false);
});

test('login válido emite token; inválido é recusado', () => {
  const auth = service();
  const bad = auth.login('errado');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, 'invalid-password');

  const good = auth.login('senha123');
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.ok(good.token.includes('.'));
    assert.ok(Number.isFinite(Date.parse(good.expiresAt)));
  }
});

test('login sem configuração de segurança responde not-configured', () => {
  const auth = service(null);
  const result = auth.login('qualquer');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'not-configured');
});

test('token verifica, expira e não valida manipulação', async () => {
  const auth = service();
  const result = auth.login('senha123');
  if (!result.ok) throw new Error('login deveria passar');

  const payload = auth.verifyToken(result.token);
  assert.ok(payload !== null);
  assert.equal(payload.sub, 'dashboard');

  assert.equal(auth.verifyToken(`${result.token}x`), null);
  assert.equal(auth.verifyToken('abc.xyz'), null);
  assert.equal(auth.verifyToken(''), null);

  const authShort = service(undefined, 1);
  const short = authShort.login('senha123');
  if (!short.ok) throw new Error('login deveria passar');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(authShort.verifyToken(short.token), null);
});

test('token não cruza entre instâncias com segredos diferentes', () => {
  const authA = service();
  const authB = new AuthService({
    tokenSecret: generateTokenSecret(),
    passwordHash: hashPassword('senha123'),
  });
  const result = authA.login('senha123');
  if (!result.ok) throw new Error('login deveria passar');
  assert.equal(authB.verifyToken(result.token), null);
});

test('updateSecrets troca segredo e invalida tokens antigos', async () => {
  const auth = service();
  const result = auth.login('senha123');
  if (!result.ok) throw new Error('login deveria passar');

  const nextSecret = generateTokenSecret();
  const nextHash = hashPassword('senha-nova');
  auth.updateSecrets({ tokenSecret: nextSecret, passwordHash: nextHash });
  assert.equal(auth.verifyToken(result.token), null);
  assert.equal(auth.login('senha123').ok, false);
  assert.equal(auth.login('senha-nova').ok, true);
});

/**
 * ETAPA 9: comparação de versões sem dependência — cobre semver clássico
 * (`0.1.0`), prefixo `v` (`v1.2.3`) e datas do GitHub (`2026.10.26`).
 * Pré-release (`-rc1`, `-beta.2`) fica ABAIXO da versão igual limpa.
 */

export function parseVersion(raw: string): { segments: number[]; prerelease: string } | null {
  const text = raw.trim().replace(/^v/i, '');
  const match = /^(\d+(?:\.\d+)+)(?:-([0-9A-Za-z.-]+))?/.exec(text);
  if (match === null || match[1] === undefined) return null;
  const segments = match[1].split('.').map((part) => Number(part));
  if (segments.some((part) => !Number.isFinite(part))) return null;
  return { segments, prerelease: match[2] ?? '' };
}

/**
 * true quando `candidate` é MAIS NOVA que `current`. Igualdade → false.
 * Pré-release da mesma base perde pra base limpa (1.2.3-rc1 < 1.2.3);
 * duas pré-releases comparam lexicográfico (rc2 > rc1).
 */
export function isNewerVersion(currentRaw: string, candidateRaw: string): boolean {
  const current = parseVersion(currentRaw);
  const candidate = parseVersion(candidateRaw);
  if (current === null || candidate === null) {
    // Versão local quebrada ou candidata sem semver: conservador,
    // não atualiza (honesto: sem chute de "provavelmente é nova").
    return false;
  }

  const length = Math.max(current.segments.length, candidate.segments.length);
  for (let index = 0; index < length; index++) {
    const left = current.segments[index] ?? 0;
    const right = candidate.segments[index] ?? 0;
    if (right > left) return true;
    if (right < left) return false;
  }

  if (current.prerelease === '' && candidate.prerelease !== '') return false;
  if (current.prerelease !== '' && candidate.prerelease === '') return true;
  if (current.prerelease === '' && candidate.prerelease === '') return false;
  return candidate.prerelease > current.prerelease;
}

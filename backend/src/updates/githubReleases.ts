/**
 * ETAPA 9: seleção de release por canal — puro e sem rede, fáceis de
 * testar. Drafts ficam FORA em todos os canais (o payload de draft não
 * vem de `published_at`, e a API pública não entrega release rascunho).
 */

export interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  body?: unknown;
  assets?: unknown;
}

export interface ReleaseAssetInfo {
  name: string;
  size: number;
  downloadUrl: string;
  /** `created_at` do asset — decide qual zip é o mais novo em empate. */
  createdAt: string;
}

export interface ParsedRelease {
  tagName: string;
  name: string;
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
  notes: string | null;
  assets: ReleaseAssetInfo[];
}

export type UpdatesChannelName = 'stable' | 'beta' | 'development';

/** Extrai release legível do payload cru do GitHub (sem inventar campo). */
export function parseRelease(raw: unknown): ParsedRelease | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const tagName = typeof item['tag_name'] === 'string' ? item['tag_name'] : '';
  if (tagName === '') return null;
  const publishedAt = typeof item['published_at'] === 'string' ? item['published_at'] : '';
  if (publishedAt === '') return null; // draft ou malformado → fora
  const assetsRaw = Array.isArray(item['assets']) ? item['assets'] : [];
  const assets: ReleaseAssetInfo[] = [];
  for (const assetRaw of assetsRaw) {
    if (typeof assetRaw !== 'object' || assetRaw === null) continue;
    const asset = assetRaw as Record<string, unknown>;
    const name = typeof asset['name'] === 'string' ? asset['name'] : '';
    const size = typeof asset['size'] === 'number' ? asset['size'] : -1;
    const url = typeof asset['browser_download_url'] === 'string' ? asset['browser_download_url'] : '';
    if (name === '' || size <= 0 || url === '') continue;
    assets.push({
      name,
      size,
      downloadUrl: url,
      createdAt: typeof asset['created_at'] === 'string' ? asset['created_at'] : '',
    });
  }
  return {
    tagName,
    name: typeof item['name'] === 'string' && item['name'].trim() !== '' ? item['name'] : tagName,
    prerelease: item['prerelease'] === true,
    publishedAt,
    htmlUrl: typeof item['html_url'] === 'string' ? item['html_url'] : '',
    notes: typeof item['body'] === 'string' && item['body'].trim() !== '' ? item['body'].slice(0, 4000) : null,
    assets,
  };
}

/**
 * Ordenação estável por publicação (mais novos primeiro). Data podre
 * cai pro fim, não pro começo (honesto).
 */
function compareByDate(left: ParsedRelease, right: ParsedRelease): number {
  const leftTime = Date.parse(left.publishedAt);
  const rightTime = Date.parse(right.publishedAt);
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
  if (Number.isNaN(leftTime)) return 1;
  if (Number.isNaN(rightTime)) return -1;
  return rightTime - leftTime;
}

/**
 * Canal → escolha documentada:
 * - `stable`: release final mais recente (sem prerelease).
 * - `beta` e `development`: a publicada mais recente, final ou pré
 *   (o GitHub só expõe publicadas; drafts ficam de fora — honesto).
 */
export function pickReleaseForChannel(
  releases: unknown[],
  channel: UpdatesChannelName,
): ParsedRelease | null {
  const parsed = releases
    .map((item) => parseRelease(item))
    .filter((item): item is ParsedRelease => item !== null)
    .filter((item) => item.prerelease === false || channel !== 'stable')
    .sort(compareByDate);
  return parsed[0] ?? null;
}

/**
 * Escolhe o pacote do Geraldo dentro de um release. Convenção do
 * projeto: um único `.zip` com `version.txt` + `backend/` + `frontend/`
 * na raiz. Se existirem vários, vence o asset com `created_at` mais
 * novo; empate (ou data faltando) cai pro nome em ordem alfabética —
 * determinístico mesmo quando o GitHub bagunça a ordem.
 */
export function pickBundleAsset(release: ParsedRelease): ReleaseAssetInfo | null {
  const folders = release.assets
    .filter((asset) => asset.name.toLowerCase().endsWith('.zip') && asset.size > 0);
  if (folders.length === 0) return null;
  folders.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    const leftKnown = !Number.isNaN(leftTime);
    const rightKnown = !Number.isNaN(rightTime);
    if (leftKnown && rightKnown && leftTime !== rightTime) return rightTime - leftTime;
    if (leftKnown && !rightKnown) return -1;
    if (!leftKnown && rightKnown) return 1;
    return left.name.localeCompare(right.name);
  });
  return folders[0] ?? null;
}

/** Procura `<pacote>.sha256` (case-insensitive) no mesmo release. */
export function pickChecksumAsset(release: ParsedRelease, bundleName: string): ReleaseAssetInfo | null {
  const suffix = `${bundleName.toLowerCase()}.sha256`;
  const matches = release.assets.filter(
    (asset) => asset.name.toLowerCase() === suffix,
  );
  return matches[0] ?? null;
}

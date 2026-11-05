import { useLocation } from 'react-router-dom';
import { Card, EmptyState, Badge } from '../components/ui.tsx';

const MODULE_BY_PATH: Record<string, { title: string; etapa: number; description: string }> = {
  '/midias': {
    title: 'Mídias',
    etapa: 4,
    description: 'Arquivos baixados, memes/sons convertidos, vídeos e imagens — organizados por categoria.',
  },
  '/atualizacoes': {
    title: 'Atualizações',
    etapa: 9,
    description:
      'Atualização automática via GitHub Releases com verificação SHA-256, backup, instalação assistida e rollback.',
  },
};

export function Placeholder() {
  const { pathname } = useLocation();
  const module = MODULE_BY_PATH[pathname];
  if (module) {
    return (
      <Card title="Módulo em construção">
        <EmptyState title={`${module.title} — chega na ETAPA ${module.etapa}`}>
          {module.description} O cronograma está no <code>PROGRESS.md</code>; quando a etapa for
          implementada, esta página passa a valer de verdade (sem botão de mentira).
        </EmptyState>
      </Card>
    );
  }
  // Rota desconhecida: estado honesto também.
  return (
    <Card title="Não implementado ainda">
      <EmptyState title="Nada por aqui">
        <Badge tone="warn">esta rota não corresponde a nenhum módulo do Geraldo</Badge>
      </EmptyState>
    </Card>
  );
}

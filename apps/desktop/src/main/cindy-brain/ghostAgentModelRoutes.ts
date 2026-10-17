import {
  connectedProvidersForAgent,
  isModelSelectableForNewRoute,
  isModelVisible,
  type ProviderView,
} from '@cindy/model-providers';
import type {
  GhostAgentModelRoutesResult,
  GhostAgentModelSourceErrorCode,
  GhostAgentModelSourceKind,
} from '../../shared/ghost.js';
import type { AgentModelSourceLocation } from '../remote-agent/controller/modelSources.js';

const AGENTS = ['codex', 'claude-code', 'pi'] as const;
const BUDGET_MS = 8_000;
const MERGE_FRESH_MS = 5_000;
const CONTROLLED_RETRY = '请稍后重试。不探测未授权来源。';

export type GhostAgentModelRoutesQuery =
  | { ok: true; source?: string }
  | Extract<GhostAgentModelRoutesResult, { ok: false }>;

export function parseAgentModelRoutesQuery(url: URL): GhostAgentModelRoutesQuery {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return { ok: true };
  const sources = url.searchParams.getAll('source');
  if (keys.length !== 1 || keys[0] !== 'source' || sources.length !== 1 || sources[0] === '') {
    return { ok: false, errorCode: 'INVALID_QUERY', message: 'Only an optional source query is allowed' };
  }
  return { ok: true, source: sources[0] };
}

export function projectGhostAgentRouteModels(input: {
  views: ProviderView[];
  availableAgents?: readonly string[];
  agentDeviceId: string;
  sourceName: string;
  visibilityOverride: (agent: 'codex' | 'claude-code' | 'pi', providerId: string, modelId: string) => boolean | undefined;
}): Extract<GhostAgentModelRoutesResult, { ok: true }>['models'] {
  const models: Extract<GhostAgentModelRoutesResult, { ok: true }>['models'] = [];
  for (const agent of AGENTS) {
    if (input.availableAgents && !input.availableAgents.includes(agent)) continue;
    for (const provider of connectedProvidersForAgent(input.views, agent)) {
      for (const model of provider.models[agent] ?? []) {
        if (!isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })) continue;
        if (!isModelVisible(input.visibilityOverride(agent, provider.id, model.id), model.defaultEnabled)) continue;
        models.push({
          id: model.id,
          name: model.name,
          agent,
          providerId: provider.id,
          providerName: provider.name,
          agentDeviceId: input.agentDeviceId,
          sourceName: input.sourceName,
          efforts: Array.isArray(model.efforts) ? [...model.efforts] : [],
          defaultEffort: model.defaultEffort ?? null,
          supportsFastMode: typeof model.supportsFastMode === 'boolean' ? model.supportsFastMode : null,
          visible: true,
        });
      }
    }
  }
  return models;
}

export function classifySourceFailure(error: unknown): {
  errorCode: GhostAgentModelSourceErrorCode;
  message: string;
} {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const text = error instanceof Error ? error.message : String(error);
  if (/REMOTE_AGENT_SHARE_(PAUSED|REMOVED|UNAVAILABLE)|SOURCE_ACCESS_REVOKED/.test(`${code} ${text}`)) {
    return { errorCode: 'SOURCE_ACCESS_REVOKED', message: '该来源已撤销或暂停，请重新选择。' };
  }
  if (/CATALOG_TIMEOUT|TIMEOUT|ETIMEDOUT/.test(`${code} ${text}`)) {
    return { errorCode: 'CATALOG_TIMEOUT', message: '读取超时。' + CONTROLLED_RETRY };
  }
  if (/Invalid provider list|CATALOG_INVALID/.test(text)) {
    return { errorCode: 'CATALOG_INVALID', message: '来源目录格式无效。' + CONTROLLED_RETRY };
  }
  if (/SOURCE_UNSUPPORTED|UNSUPPORTED_CAPABILITY/.test(`${code} ${text}`)) {
    return { errorCode: 'SOURCE_UNSUPPORTED', message: '来源端 Cindy 过旧，请升级后再选远程模型。' };
  }
  return { errorCode: 'SOURCE_UNREACHABLE', message: '来源暂时不可达。' + CONTROLLED_RETRY };
}

type SourceRead = {
  id: string;
  name: string;
  kind: GhostAgentModelSourceKind;
  status: 'ready' | 'empty' | 'unavailable';
  checkedAt: number;
  startedAt: number;
  errorCode?: GhostAgentModelSourceErrorCode;
  message?: string;
  models: Extract<GhostAgentModelRoutesResult, { ok: true }>['models'];
};

const inflightReads = new Map<string, { startedAt: number; promise: Promise<SourceRead> }>();

export function createGhostAgentModelRoutesService(deps: {
  now?: () => number;
  budgetMs?: number;
  ownerKey?: () => string;
  listSources: () => Promise<AgentModelSourceLocation[]>;
  readLocal: () => Promise<{
    views: ProviderView[];
    availableAgents: readonly string[];
    visibilityOverride: (agent: 'codex' | 'claude-code' | 'pi', providerId: string, modelId: string) => boolean | undefined;
  }>;
  readRemote: (
    sourceId: string,
    isCurrent: () => boolean,
  ) => Promise<{
    views: ProviderView[];
    modelVisibilityOverrides: Record<string, boolean> | null;
  }>;
  isCurrent: () => boolean;
}) {
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? BUDGET_MS;

  const readSource = (source: AgentModelSourceLocation): Promise<SourceRead> => {
    const key = `${deps.ownerKey?.() ?? 'default'}:${source.agentDeviceId}`;
    const existing = inflightReads.get(key);
    const startedAt = now();
    if (existing && startedAt - existing.startedAt <= MERGE_FRESH_MS) return existing.promise;
    const promise = (async (): Promise<SourceRead> => {
      try {
        if (source.kind === 'local') {
          const local = await deps.readLocal();
          const models = projectGhostAgentRouteModels({
            views: local.views,
            availableAgents: local.availableAgents,
            agentDeviceId: source.agentDeviceId,
            sourceName: source.name,
            visibilityOverride: local.visibilityOverride,
          });
          return {
            id: source.agentDeviceId,
            name: source.name,
            kind: source.kind,
            status: models.length ? 'ready' : 'empty',
            checkedAt: now(),
            startedAt,
            models,
          };
        }
        const remote = await deps.readRemote(source.agentDeviceId, deps.isCurrent);
        if (remote.modelVisibilityOverrides == null) {
          return {
            id: source.agentDeviceId,
            name: source.name,
            kind: source.kind,
            status: 'unavailable',
            checkedAt: now(),
            startedAt,
            errorCode: 'SOURCE_UNSUPPORTED',
            message: '来源端未提供模型可见性合同，请升级来源端 Cindy。',
            models: [],
          };
        }
        const models = projectGhostAgentRouteModels({
          views: remote.views,
          agentDeviceId: source.agentDeviceId,
          sourceName: source.name,
          visibilityOverride: (agent, providerId, modelId) =>
            remote.modelVisibilityOverrides?.[`${agent}:${providerId}:${modelId}`],
        });
        return {
          id: source.agentDeviceId,
          name: source.name,
          kind: source.kind,
          status: models.length ? 'ready' : 'empty',
          checkedAt: now(),
          startedAt,
          models,
        };
      } catch (error) {
        const failure = classifySourceFailure(error);
        return {
          id: source.agentDeviceId,
          name: source.name,
          kind: source.kind,
          status: 'unavailable',
          checkedAt: now(),
          startedAt,
          ...failure,
          models: [],
        };
      } finally {
        const current = inflightReads.get(key);
        if (current?.startedAt === startedAt) inflightReads.delete(key);
      }
    })();
    inflightReads.set(key, { startedAt, promise });
    return promise;
  };

  return async (query: { source?: string } = {}): Promise<GhostAgentModelRoutesResult> => {
    const checkedAt = now();
    if (!deps.isCurrent()) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: 'Plugin unavailable' };
    }
    let sources: AgentModelSourceLocation[];
    try {
      sources = await deps.listSources();
    } catch {
      return { ok: false, errorCode: 'NOT_AVAILABLE', message: 'Model catalog unavailable' };
    }
    if (!deps.isCurrent()) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: 'Plugin unavailable' };
    }
    if (query.source && !sources.some((source) => source.agentDeviceId === query.source)) {
      return { ok: false, errorCode: 'SOURCE_NOT_ALLOWED', message: 'Source is not in the authorized directory' };
    }
    const selected = query.source
      ? sources.filter((source) => source.agentDeviceId === query.source)
      : sources;
    const remaining = Math.max(0, budgetMs - (now() - checkedAt));
    const results: SourceRead[] = await Promise.all(selected.map((source) => {
      const timeout: Promise<SourceRead> = new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            id: source.agentDeviceId,
            name: source.name,
            kind: source.kind,
            status: 'unavailable',
            checkedAt: now(),
            startedAt: checkedAt,
            errorCode: 'CATALOG_TIMEOUT',
            message: '读取超时。' + CONTROLLED_RETRY,
            models: [],
          });
        }, remaining);
      });
      return Promise.race([readSource(source), timeout]);
    }));
    if (!deps.isCurrent()) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: 'Plugin unavailable' };
    }
    const models: Extract<GhostAgentModelRoutesResult, { ok: true }>['models'] = [];
    const sourceRows = results.map((result) => {
      const stale = result.startedAt < checkedAt && now() - result.startedAt > MERGE_FRESH_MS;
      if (stale && result.status !== 'unavailable') {
        return {
          id: result.id,
          name: result.name,
          kind: result.kind,
          status: 'unavailable' as const,
          checkedAt: now(),
          errorCode: 'CATALOG_TIMEOUT' as const,
          message: '读取结果已过期，请重试。',
        };
      }
      if (!stale) models.push(...result.models);
      return {
        id: result.id,
        name: result.name,
        kind: result.kind,
        status: result.status,
        checkedAt: result.checkedAt,
        ...(result.errorCode ? { errorCode: result.errorCode, message: result.message } : {}),
      };
    });
    return {
      ok: true,
      version: 1,
      checkedAt,
      complete: sourceRows.every((source) => source.status !== 'unavailable'),
      sources: sourceRows,
      models,
    };
  };
}

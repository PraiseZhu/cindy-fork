import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import {
  classifySourceFailure,
  createGhostAgentModelRoutesService,
  parseAgentModelRoutesQuery,
  projectGhostAgentRouteModels,
} from '../ghostAgentModelRoutes.js';

const provider = (id: string, efforts: string[], extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    source: 'user',
    connected: true,
    agents: ['codex'],
    routing: { codex: { enabled: true } },
    models: {
      codex: [
        {
          id: 'model',
          name: 'Model',
          mode: 'chat',
          efforts,
          defaultEffort: efforts[0] ?? null,
          supportsFastMode: extra.supportsFastMode,
          defaultEnabled: extra.defaultEnabled,
        },
      ],
    },
    auth: { apiKey: 'secret' },
    endpoint: 'private',
  }) as unknown as ProviderView;

describe('parseAgentModelRoutesQuery', () => {
  it('accepts no query or a single source and rejects everything else', () => {
    expect(parseAgentModelRoutesQuery(new URL('cindy-ghost://p/agent-model-routes'))).toEqual({ ok: true });
    expect(parseAgentModelRoutesQuery(new URL('cindy-ghost://p/agent-model-routes?source=local'))).toEqual({
      ok: true,
      source: 'local',
    });
    expect(parseAgentModelRoutesQuery(new URL('cindy-ghost://p/agent-model-routes?source=local&source=air')).ok).toBe(false);
    expect(parseAgentModelRoutesQuery(new URL('cindy-ghost://p/agent-model-routes?owner=x')).ok).toBe(false);
    expect(parseAgentModelRoutesQuery(new URL('cindy-ghost://p/agent-model-routes?source=')).ok).toBe(false);
  });
});

describe('projectGhostAgentRouteModels', () => {
  it('keeps source identity, omits hidden models, and does not leak credentials', () => {
    const hidden = provider('a', ['high'], { defaultEnabled: false });
    const shown = provider('b', ['medium'], { supportsFastMode: true });
    const models = projectGhostAgentRouteModels({
      views: [hidden, shown],
      availableAgents: ['codex'],
      agentDeviceId: 'share:abc',
      sourceName: 'Anthropic · Claude',
      visibilityOverride: (_agent, id) => (id === 'a' ? false : true),
    });
    expect(models).toEqual([
      {
        id: 'model',
        name: 'Model',
        agent: 'codex',
        providerId: 'b',
        providerName: 'b',
        agentDeviceId: 'share:abc',
        sourceName: 'Anthropic · Claude',
        efforts: ['medium'],
        defaultEffort: 'medium',
        supportsFastMode: true,
        visible: true,
      },
    ]);
    expect(JSON.stringify(models)).not.toContain('secret');
    expect(JSON.stringify(models)).not.toContain('private');
  });
});

describe('createGhostAgentModelRoutesService', () => {
  it('keeps other sources when one remote catalog fails and rejects unknown sources', async () => {
    const list = async () => [
      { agentDeviceId: 'local', name: '本机', kind: 'local' as const },
      { agentDeviceId: 'share:abc', name: 'Claude', kind: 'share' as const },
    ];
    const service = createGhostAgentModelRoutesService({
      listSources: list,
      isCurrent: () => true,
      readLocal: async () => ({
        views: [provider('local', ['high'])],
        availableAgents: ['codex'],
        visibilityOverride: () => true,
      }),
      readRemote: async () => {
        throw Object.assign(new Error('[REMOTE_AGENT_SHARE_PAUSED] paused'), { code: 'REMOTE_AGENT_SHARE_PAUSED' });
      },
    });
    const result = await service();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.complete).toBe(false);
    expect(result.models.map((model) => model.agentDeviceId)).toEqual(['local']);
    expect(result.sources.find((source) => source.id === 'share:abc')).toMatchObject({
      status: 'unavailable',
      errorCode: 'SOURCE_ACCESS_REVOKED',
    });
    expect(await service({ source: 'missing' })).toMatchObject({ ok: false, errorCode: 'SOURCE_NOT_ALLOWED' });
  });

  it('marks a missing remote visibility contract unsupported instead of assuming every model is on', async () => {
    const service = createGhostAgentModelRoutesService({
      listSources: async () => [{ agentDeviceId: 'air', name: 'Air', kind: 'device' }],
      isCurrent: () => true,
      readLocal: async () => ({ views: [], availableAgents: [], visibilityOverride: () => undefined }),
      readRemote: async () => ({ views: [provider('remote', ['high'])], modelVisibilityOverrides: null }),
    });
    const result = await service();
    expect(result.ok && result.models).toEqual([]);
    expect(result.ok && result.sources[0]).toMatchObject({ status: 'unavailable', errorCode: 'SOURCE_UNSUPPORTED' });
  });
});

describe('classifySourceFailure', () => {
  it('never forwards raw exceptions', () => {
    expect(classifySourceFailure(new Error('secret upstream details')).message).not.toContain('secret');
    expect(classifySourceFailure(new Error('Invalid provider list response')).errorCode).toBe('CATALOG_INVALID');
  });
});

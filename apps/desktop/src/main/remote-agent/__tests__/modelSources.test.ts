import { describe, expect, it } from 'vitest';

import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';
import { listAgentModelSourceLocations } from '../controller/modelSources';

const device = (overrides: Partial<DeviceLinkDeviceView> = {}): DeviceLinkDeviceView => ({
  deviceId: 'air',
  name: 'Air',
  platform: 'darwin',
  appVersion: '1',
  lastSeenAt: null,
  online: true,
  busy: false,
  remoteControlEnabled: true,
  controlEnabled: true,
  isSelf: false,
  ...overrides,
});

describe('listAgentModelSourceLocations', () => {
  it('includes local, eligible devices, and active shares with opaque ids', () => {
    const sources = listAgentModelSourceLocations({
      devices: [
        device(),
        device({ deviceId: 'phone', name: 'Phone', platform: 'ios' }),
        device({ deviceId: 'offline', name: 'Offline', online: false }),
      ],
      shares: [
        { shareId: 'abc', status: 'active', providerLabel: 'Anthropic', owner: { displayName: 'Claude' } },
        { shareId: 'paused', status: 'paused', providerLabel: 'Hidden', owner: { displayName: 'Kai' } },
      ],
      isDeviceCandidate: (item) => item.online && item.platform !== 'ios' && !item.isSelf,
      shareAgentDeviceId: (shareId) => `share:${shareId}`,
    });
    expect(sources).toEqual([
      { agentDeviceId: 'local', name: '本机', kind: 'local' },
      { agentDeviceId: 'air', name: 'Air', kind: 'device' },
      { agentDeviceId: 'share:abc', name: 'Anthropic · Claude', kind: 'share' },
    ]);
  });

  it('can omit local so Orca locations stay id/name only', () => {
    const sources = listAgentModelSourceLocations({
      devices: [device({ name: '' })],
      includeLocal: false,
      isDeviceCandidate: () => true,
      shareAgentDeviceId: (shareId) => `share:${shareId}`,
    });
    expect(sources).toEqual([{ agentDeviceId: 'air', name: 'air', kind: 'device' }]);
  });

  it('drops invalid share ids instead of inventing a source', () => {
    const sources = listAgentModelSourceLocations({
      devices: [],
      includeLocal: false,
      shares: [{ shareId: 'bad', status: 'active', providerLabel: 'X', owner: { displayName: 'Y' } }],
      isDeviceCandidate: () => true,
      shareAgentDeviceId: () => {
        throw new Error('Invalid provider share id');
      },
    });
    expect(sources).toEqual([]);
  });
});

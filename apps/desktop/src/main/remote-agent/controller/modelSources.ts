/**
 * Enumerate authorized Agent model sources for plugins and Orca.
 *
 * Local is always `local`. Other computers reuse the Orca execution-device
 * candidate filter. Received shares keep their opaque `share:<id>` identity
 * and the existing share display name (provider · owner), never the owner's
 * computer name.
 */
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';

export type AgentModelSourceKind = 'local' | 'device' | 'share';

export interface AgentModelSourceLocation {
  agentDeviceId: string;
  name: string;
  kind: AgentModelSourceKind;
}

export interface AgentModelSourceShare {
  shareId: string;
  status: string;
  providerLabel: string;
  owner: { displayName: string };
}

export function listAgentModelSourceLocations(input: {
  devices: readonly DeviceLinkDeviceView[];
  shares?: readonly AgentModelSourceShare[];
  includeLocal?: boolean;
  localName?: string;
  isDeviceCandidate: (device: DeviceLinkDeviceView) => boolean;
  shareAgentDeviceId: (shareId: string) => string;
}): AgentModelSourceLocation[] {
  const sources: AgentModelSourceLocation[] = [];
  if (input.includeLocal !== false) {
    sources.push({ agentDeviceId: 'local', name: input.localName ?? '本机', kind: 'local' });
  }
  for (const device of input.devices) {
    if (!input.isDeviceCandidate(device)) continue;
    sources.push({
      agentDeviceId: device.deviceId,
      name: device.name || device.deviceId,
      kind: 'device',
    });
  }
  for (const share of input.shares ?? []) {
    if (share.status !== 'active') continue;
    try {
      sources.push({
        agentDeviceId: input.shareAgentDeviceId(share.shareId),
        name: `${share.providerLabel} · ${share.owner.displayName}`,
        kind: 'share',
      });
    } catch {
      continue;
    }
  }
  return sources;
}

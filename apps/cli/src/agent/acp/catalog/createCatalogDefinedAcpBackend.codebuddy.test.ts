import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, SessionId } from '@/agent/core';

const { createAcpBackend } = vi.hoisted(() => ({ createAcpBackend: vi.fn() }));

vi.mock('@/agent/acp/createAcpBackend', () => ({ createAcpBackend }));
vi.mock('@/runtime/managedTools/requireProviderCliLaunchSpec', () => ({
  requireProviderCliLaunchSpec: () => ({ command: '/usr/local/bin/codebuddy', args: [] }),
}));

import { createCatalogDefinedAcpBackend } from './createCatalogDefinedAcpBackend';

function createBackend(): AgentBackend & { setSessionMode: ReturnType<typeof vi.fn> } {
  return {
    startSession: vi.fn(async () => ({ sessionId: 'started' as SessionId })),
    loadSession: vi.fn(async (sessionId: SessionId) => ({ sessionId })),
    sendPrompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onMessage: vi.fn(),
    dispose: vi.fn(async () => {}),
    setSessionMode: vi.fn(async () => {}),
  };
}

describe('createCatalogDefinedAcpBackend (CodeBuddy Code)', () => {
  beforeEach(() => {
    createAcpBackend.mockReset();
  });

  it('launches `codebuddy --acp`, declares session/load, and passes Happier MCP servers through ACP', async () => {
    const backend = createBackend();
    createAcpBackend.mockReturnValue(backend);
    const mcpServers = { happier: { command: 'happier-mcp' } };

    const created = createCatalogDefinedAcpBackend('codebuddy' as never, {
      cwd: '/workspace',
      permissionMode: 'default',
      mcpServers,
    });
    await created.startSession();

    expect(createAcpBackend).toHaveBeenCalledWith(expect.objectContaining({
      command: '/usr/local/bin/codebuddy',
      args: ['--acp'],
      declaredSessionLoadSupport: true,
      sessionModesEnabled: true,
      mcpServers,
    }));
    expect(backend.setSessionMode).not.toHaveBeenCalled();
  });

  it.each([
    ['read-only', 'default'],
    ['safe-yolo', 'acceptEdits'],
    ['yolo', 'bypassPermissions'],
    ['plan', 'plan'],
  ] as const)('applies explicit Happier mode %s as CodeBuddy ACP mode %s', async (permissionMode, codebuddyMode) => {
    const backend = createBackend();
    createAcpBackend.mockReturnValue(backend);

    const created = createCatalogDefinedAcpBackend('codebuddy' as never, {
      cwd: '/workspace',
      permissionMode,
    });
    await created.startSession();

    expect(backend.setSessionMode).toHaveBeenCalledWith('started', codebuddyMode);
  });

  it('reapplies the explicit CodeBuddy mode after loading a vendor session', async () => {
    const backend = createBackend();
    createAcpBackend.mockReturnValue(backend);

    const created = createCatalogDefinedAcpBackend('codebuddy' as never, {
      cwd: '/workspace',
      permissionMode: 'safe-yolo',
    });
    await created.loadSession?.('resumed' as SessionId);

    expect(backend.setSessionMode).toHaveBeenCalledWith('resumed', 'acceptEdits');
  });
});

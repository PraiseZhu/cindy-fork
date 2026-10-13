import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { relocateLibraryMetaOwner } from '../libraryBinding.js';
import {
  finishLegacyLibraryReattach,
  readLegacyLibraryReattachJournal,
  startLegacyLibraryReattach,
  type LegacyLibraryReattachDeps,
} from '../libraryLegacyReattach.js';

const FROM = 'xd-mivo-canvas';
const TO = '_ns__xd__xd-mivo-canvas';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-library-reattach-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function plantLibrary(dir: string, ghostId: string, marker: string): void {
  fs.mkdirSync(path.join(dir, '.cindy-library'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.cindy-library', 'meta.json'),
    JSON.stringify({ version: 1, ghostId, createdAt: 1, orphaned: { at: 1, name: 'Mivo Canvas' } }),
  );
  fs.writeFileSync(path.join(dir, 'marker.txt'), marker);
}

function readMeta(dir: string): { ghostId: string } {
  return JSON.parse(fs.readFileSync(path.join(dir, '.cindy-library', 'meta.json'), 'utf8')) as { ghostId: string };
}

function deps(overrides: Partial<LegacyLibraryReattachDeps> = {}): LegacyLibraryReattachDeps {
  return {
    journalFile: () => path.join(root, 'library-reattach.json'),
    defaultRoot: (id) => path.join(root, 'libraries', id),
    stagingRoot: (id) => path.join(root, 'library-staging', id),
    trashRoot: () => path.join(root, 'libraries-trash'),
    relocateCustomBinding: async () => {},
    customRoot: async () => null,
    relocateMeta: async (dir, fromId, toId) => {
      await relocateLibraryMetaOwner(dir, fromId, toId);
    },
    relocateStaging: async (dir, fromId, toId) => {
      await relocateLibraryMetaOwner(dir, fromId, toId);
    },
    clearPanelStorage: async () => {},
    assertCurrent: () => {},
    ...overrides,
  };
}

function plantDefaultPair(): void {
  plantLibrary(path.join(root, 'libraries', FROM), FROM, 'old');
  plantLibrary(path.join(root, 'libraries', TO), TO, 'new');
  plantLibrary(path.join(root, 'library-staging', FROM), FROM, 'old-staging');
  plantLibrary(path.join(root, 'library-staging', TO), TO, 'new-staging');
}

function expectReattached(): void {
  const library = path.join(root, 'libraries', TO);
  expect(fs.readFileSync(path.join(library, 'marker.txt'), 'utf8')).toBe('old');
  expect(readMeta(library).ghostId).toBe(TO);
  expect(fs.existsSync(path.join(root, 'libraries', FROM))).toBe(false);
  const staging = path.join(root, 'library-staging', TO);
  expect(fs.readFileSync(path.join(staging, 'marker.txt'), 'utf8')).toBe('old-staging');
  expect(readMeta(staging).ghostId).toBe(TO);
  const trash = path.join(root, 'libraries-trash', `${TO}-7-replaced`);
  expect(fs.readFileSync(path.join(trash, 'marker.txt'), 'utf8')).toBe('new');
  expect(fs.readFileSync(path.join(`${trash}-staging`, 'marker.txt'), 'utf8')).toBe('new-staging');
  expect(fs.existsSync(path.join(root, 'library-reattach.json'))).toBe(false);
}

describe('legacy library reattach', () => {
  it('moves the current library to the trash and puts the old one in its place', async () => {
    plantDefaultPair();
    await startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'default', now: 7 }, deps());
    expectReattached();
  });

  it('reattaches when the current instance never created a library', async () => {
    plantLibrary(path.join(root, 'libraries', FROM), FROM, 'old');
    await startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'default', now: 7 }, deps());
    expect(readMeta(path.join(root, 'libraries', TO)).ghostId).toBe(TO);
    expect(fs.existsSync(path.join(root, 'libraries-trash'))).toBe(false);
  });

  it.each(Array.from({ length: 9 }, (_, index) => index + 1))(
    'finishes from the journal after stopping at check %i',
    async (stopAt) => {
      plantDefaultPair();
      let checks = 0;
      const interrupted = deps({
        assertCurrent: () => {
          checks += 1;
          if (checks === stopAt) throw new Error('stopped');
        },
      });
      await expect(startLegacyLibraryReattach(
        { fromId: FROM, toId: TO, oldLocation: 'default', now: 7 },
        interrupted,
      )).rejects.toThrow('stopped');
      const journal = await readLegacyLibraryReattachJournal(path.join(root, 'library-reattach.json'));
      if (journal) await finishLegacyLibraryReattach(journal, deps());
      if (stopAt <= 2) {
        // Stopped before the journal was written: nothing moved.
        expect(journal).toBeNull();
        expect(fs.readFileSync(path.join(root, 'libraries', TO, 'marker.txt'), 'utf8')).toBe('new');
        return;
      }
      expectReattached();
    },
  );

  it('does not trash a different library that took the current place', async () => {
    plantDefaultPair();
    await expect(startLegacyLibraryReattach(
      { fromId: FROM, toId: TO, oldLocation: 'default', now: 7 },
      deps({ assertCurrent: (() => {
        let checks = 0;
        return () => {
          checks += 1;
          if (checks === 3) throw new Error('stopped');
        };
      })() }),
    )).rejects.toThrow('stopped');
    const current = path.join(root, 'libraries', TO);
    // Keep the original inode alive so the replacement cannot reuse it.
    fs.renameSync(current, path.join(root, 'moved-away'));
    plantLibrary(current, TO, 'replacement');
    const journal = await readLegacyLibraryReattachJournal(path.join(root, 'library-reattach.json'));
    await expect(finishLegacyLibraryReattach(journal!, deps())).rejects.toThrow('destination already exists');
    expect(fs.readFileSync(path.join(current, 'marker.txt'), 'utf8')).toBe('replacement');
    expect(fs.readFileSync(path.join(root, 'libraries', FROM, 'marker.txt'), 'utf8')).toBe('old');
  });

  it('refuses to start another reattach while one is unfinished', async () => {
    fs.writeFileSync(path.join(root, 'library-reattach.json'), JSON.stringify({
      version: 1, fromId: FROM, toId: TO, oldLocation: 'default', newLibrary: null, newStaging: null, trashName: 'x',
    }));
    await expect(startLegacyLibraryReattach(
      { fromId: FROM, toId: TO, oldLocation: 'default', now: 7 },
      deps(),
    )).rejects.toThrow('unfinished');
  });

  it('lets the binding store move a library at a custom location', async () => {
    const custom = path.join(root, 'custom');
    plantLibrary(path.join(custom, FROM), FROM, 'old');
    const relocateCustomBinding = vi.fn(async (fromId: string, toId: string) => {
      fs.renameSync(path.join(custom, fromId), path.join(custom, toId));
    });
    await startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'custom', now: 7 }, deps({
      relocateCustomBinding,
      customRoot: async (id) => path.join(custom, id),
    }));
    expect(relocateCustomBinding).toHaveBeenCalledWith(FROM, TO);
    expect(readMeta(path.join(custom, TO)).ghostId).toBe(TO);
  });

  it('clears the panel storage once, after the swap is finished', async () => {
    plantDefaultPair();
    const journalFile = path.join(root, 'library-reattach.json');
    const clearPanelStorage = vi.fn(async () => {
      // The swap is complete: the old library is in place and the journal is gone.
      expect(fs.readFileSync(path.join(root, 'libraries', TO, 'marker.txt'), 'utf8')).toBe('old');
      expect(fs.existsSync(journalFile)).toBe(false);
    });
    await startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'default', now: 7 }, deps({ clearPanelStorage }));
    expect(clearPanelStorage).toHaveBeenCalledOnce();
    expect(clearPanelStorage).toHaveBeenCalledWith(TO);
  });

  it('keeps the panel storage when the swap stops midway, and clears it when the journal finishes', async () => {
    plantDefaultPair();
    const clearPanelStorage = vi.fn(async () => {});
    let checks = 0;
    await expect(startLegacyLibraryReattach({ fromId: FROM, toId: TO, oldLocation: 'default', now: 7 }, deps({
      clearPanelStorage,
      assertCurrent: () => {
        checks += 1;
        if (checks === 5) throw new Error('stopped');
      },
    }))).rejects.toThrow('stopped');
    expect(clearPanelStorage).not.toHaveBeenCalled();
    const journal = await readLegacyLibraryReattachJournal(path.join(root, 'library-reattach.json'));
    await finishLegacyLibraryReattach(journal!, deps({ clearPanelStorage }));
    expect(clearPanelStorage).toHaveBeenCalledOnce();
    expect(clearPanelStorage).toHaveBeenCalledWith(TO);
    expectReattached();
  });
});

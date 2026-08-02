import { describe, expect, it } from 'bun:test';

import {
  addFolderToWorkspace,
  hasFolder,
  removeFolderFromWorkspace,
} from './workspace';

const WORKSPACE = `{
  "folders": [
    {
      "name": "sweft",
      "path": ".",
    },
  ],
  "settings": {
    // worktrees sit next to the repo
    "git.repositoryScanMaxDepth": 4,
  },
}
`;

describe('workspace folders', () => {
  it('adds a folder without touching comments or trailing commas', () => {
    const updated = addFolderToWorkspace(WORKSPACE, {
      name: 'sweft-eros-696',
      path: '../sweft-eros-696',
    });

    expect(updated).toContain('"path": "../sweft-eros-696",');
    expect(updated).toContain('// worktrees sit next to the repo');
    expect(updated).toContain('"path": ".",');
    expect(updated.match(/"folders"/g)).toHaveLength(1);
  });

  it('is a no-op when the folder is already there', () => {
    const once = addFolderToWorkspace(WORKSPACE, {
      name: 'a',
      path: '../a',
    });
    expect(addFolderToWorkspace(once, { name: 'a', path: '../a' })).toBe(once);
  });

  it('round-trips back to the original text', () => {
    const added = addFolderToWorkspace(WORKSPACE, {
      name: 'sweft-eros-696',
      path: '../sweft-eros-696',
    });
    expect(removeFolderFromWorkspace(added, '../sweft-eros-696')).toBe(
      WORKSPACE,
    );
  });

  it('leaves the file alone when removing something that is not there', () => {
    expect(removeFolderFromWorkspace(WORKSPACE, '../nope')).toBe(WORKSPACE);
  });

  it('does not confuse a path prefix for the real entry', () => {
    const added = addFolderToWorkspace(WORKSPACE, {
      name: 'sweft-eros-696-work',
      path: '../sweft-eros-696-work',
    });
    expect(hasFolder(added, '../sweft-eros-696')).toBe(false);
  });
});

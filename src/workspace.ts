export interface WorkspaceFolderEntry {
  name: string;
  path: string;
}

function findFoldersArray(lines: string[]) {
  const openIndex = lines.findIndex((line) => /"folders"\s*:\s*\[/.test(line));
  if (openIndex === -1) return null;

  let depth = 0;
  for (let index = openIndex; index < lines.length; index++) {
    for (const character of lines[index] ?? '') {
      if (character === '[') depth++;
      if (character === ']') {
        depth--;
        if (depth === 0) return { openIndex, closeIndex: index };
      }
    }
  }
  return null;
}

function indentOf(line: string) {
  return line.match(/^\s*/)?.[0] ?? '';
}

export function addFolderToWorkspace(
  workspaceText: string,
  folder: WorkspaceFolderEntry,
) {
  const lines = workspaceText.split('\n');
  const bounds = findFoldersArray(lines);
  if (!bounds) throw new Error('no "folders" array in the workspace file');
  if (hasFolder(workspaceText, folder.path)) return workspaceText;

  const baseIndent = indentOf(lines[bounds.openIndex] ?? '');
  const entryIndent = `${baseIndent}  `;
  const fieldIndent = `${entryIndent}  `;
  const entry = [
    `${entryIndent}{`,
    `${fieldIndent}"name": "${folder.name}",`,
    `${fieldIndent}"path": "${folder.path}",`,
    `${entryIndent}},`,
  ];

  lines.splice(bounds.closeIndex, 0, ...entry);
  return lines.join('\n');
}

export function removeFolderFromWorkspace(
  workspaceText: string,
  folderPath: string,
) {
  const lines = workspaceText.split('\n');
  const bounds = findFoldersArray(lines);
  if (!bounds) return workspaceText;

  const pathLine = lines.findIndex(
    (line, index) =>
      index > bounds.openIndex &&
      index < bounds.closeIndex &&
      new RegExp(`"path"\\s*:\\s*"${escapeForRegExp(folderPath)}"`).test(line),
  );
  if (pathLine === -1) return workspaceText;

  let start = pathLine;
  while (start > bounds.openIndex && !lines[start]?.includes('{')) start--;
  let end = pathLine;
  while (end < bounds.closeIndex && !lines[end]?.includes('}')) end++;

  lines.splice(start, end - start + 1);
  return lines.join('\n');
}

export function hasFolder(workspaceText: string, folderPath: string) {
  return new RegExp(`"path"\\s*:\\s*"${escapeForRegExp(folderPath)}"`).test(
    workspaceText,
  );
}

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

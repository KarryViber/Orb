import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, normalize } from 'node:path';

const GIT_DIFF_TIMEOUT_MS = 2_000;
const GIT_DIFF_MAX_FILES = 20;
const FILE_MODIFYING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function isFileModifyingTool(toolName) {
  return FILE_MODIFYING_TOOLS.has(toolName);
}

function runGit(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_DIFF_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolvePromise(String(stdout || ''));
      },
    );
  });
}

function parseGitStatusPorcelain(output) {
  const files = [];
  for (const line of String(output || '').split('\n')) {
    if (!line) continue;
    const status = line.slice(0, 2);
    const rawPath = line.slice(3);
    const renameIndex = rawPath.indexOf(' -> ');
    files.push({
      path: renameIndex >= 0 ? rawPath.slice(renameIndex + 4) : rawPath,
      status: status.trim() || status,
      linesAdded: 0,
      linesDeleted: 0,
    });
  }
  return files;
}

function normalizeStatPath(rawPath) {
  const path = String(rawPath || '').trim();
  if (!path.includes(' => ')) return path;
  const collapsed = path.replace(/[{}]/g, '');
  const parts = collapsed.split(' => ');
  return parts[parts.length - 1].trim();
}

function parseGitStat(output) {
  const stats = new Map();
  const totals = { insertions: 0, deletions: 0 };
  for (const line of String(output || '').split('\n')) {
    if (!line) continue;
    const totalMatch = line.match(/(\d+)\s+insertion(?:s)?\(\+\)/);
    const deleteMatch = line.match(/(\d+)\s+deletion(?:s)?\(-\)/);
    if (totalMatch || deleteMatch) {
      totals.insertions = totalMatch ? Number.parseInt(totalMatch[1], 10) : 0;
      totals.deletions = deleteMatch ? Number.parseInt(deleteMatch[1], 10) : 0;
      continue;
    }
    const pipeIndex = line.indexOf('|');
    if (pipeIndex < 0) continue;
    const path = normalizeStatPath(line.slice(0, pipeIndex));
    const graph = line.slice(pipeIndex + 1);
    const added = (graph.match(/\+/g) || []).length;
    const deleted = (graph.match(/-/g) || []).length;
    stats.set(path, {
      linesAdded: added,
      linesDeleted: deleted,
    });
  }
  return { stats, totals };
}

function normalizeGitRelativePath(filePath) {
  const normalized = normalize(String(filePath || '').trim()).replace(/\\/g, '/');
  return normalized === '.' ? '' : normalized.replace(/^\.\//, '');
}

function normalizeModifiedPath(cwd, filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const absolutePath = isAbsolute(filePath) ? normalize(filePath) : resolve(cwd, filePath);
  const relativePath = relative(cwd, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
  return normalizeGitRelativePath(relativePath);
}

function normalizeModifiedPathSet(cwd, modifiedPaths) {
  const normalized = new Set();
  for (const filePath of modifiedPaths || []) {
    const relativePath = normalizeModifiedPath(cwd, filePath);
    if (relativePath) normalized.add(relativePath);
  }
  return normalized;
}

export async function collectGitDiffSummary(cwd, modifiedPaths = new Set()) {
  try {
    if (!cwd || !existsSync(cwd)) return null;
    await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    const normalizedModifiedPaths = normalizeModifiedPathSet(cwd, modifiedPaths);
    if (normalizedModifiedPaths.size === 0) {
      return {
        cwd,
        hasChanges: false,
        files: [],
        totals: { filesChanged: 0, insertions: 0, deletions: 0 },
        truncated: false,
      };
    }

    const statusOutput = await runGit(['status', '--porcelain'], cwd);
    const files = parseGitStatusPorcelain(statusOutput)
      .map((file) => ({ ...file, path: normalizeGitRelativePath(file.path) }))
      .filter((file) => normalizedModifiedPaths.has(file.path));
    const hasChanges = files.length > 0;
    if (!hasChanges) {
      return {
        cwd,
        hasChanges: false,
        files: [],
        totals: { filesChanged: 0, insertions: 0, deletions: 0 },
        truncated: false,
      };
    }

    const statOutputs = await Promise.all(files.map((file) => runGit(['diff', '--stat', 'HEAD', '--', file.path], cwd)));
    const statsByPath = new Map();
    const totals = { insertions: 0, deletions: 0 };
    for (const statOutput of statOutputs) {
      const parsed = parseGitStat(statOutput);
      totals.insertions += parsed.totals.insertions;
      totals.deletions += parsed.totals.deletions;
      for (const [path, stat] of parsed.stats) {
        statsByPath.set(normalizeGitRelativePath(path), stat);
      }
    }
    for (const file of files) {
      const stat = statsByPath.get(file.path);
      if (stat && file.status !== '??') {
        file.linesAdded = stat.linesAdded;
        file.linesDeleted = stat.linesDeleted;
      }
    }

    return {
      cwd,
      hasChanges,
      files: files.slice(0, GIT_DIFF_MAX_FILES),
      totals: {
        filesChanged: files.length,
        insertions: totals.insertions,
        deletions: totals.deletions,
      },
      truncated: files.length > GIT_DIFF_MAX_FILES,
    };
  } catch (_) {
    return null;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectGitDiffSummary, recordModifiedPathFromToolUse } from '../src/worker.js';

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function write(repo, relativePath, content) {
  const fullPath = join(repo, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

function createRepo(files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'orb-git-diff-footer-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  for (const [relativePath, content] of Object.entries(files)) {
    write(repo, relativePath, content);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

function filePaths(summary) {
  return summary.files.map((file) => file.path).sort();
}

test('single Edit path limits git diff footer to that file', async () => {
  const repo = createRepo({ 'foo.md': 'before\n' });
  try {
    const fooPath = write(repo, 'foo.md', 'after\n');
    const modifiedPaths = new Set();

    assert.equal(recordModifiedPathFromToolUse({ name: 'Edit', input: { file_path: fooPath } }, modifiedPaths), true);
    const summary = await collectGitDiffSummary(repo, modifiedPaths);

    assert.equal(summary.hasChanges, true);
    assert.deepEqual(filePaths(summary), ['foo.md']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('multiple worker edits exclude unrelated dirty files', async () => {
  const repo = createRepo({
    'foo.md': 'foo before\n',
    'bar.md': 'bar before\n',
    'quux.md': 'quux before\n',
  });
  try {
    write(repo, 'foo.md', 'foo after\n');
    write(repo, 'bar.md', 'bar after\n');
    write(repo, 'quux.md', 'quux after\n');
    const modifiedPaths = new Set([join(repo, 'foo.md'), join(repo, 'bar.md')]);

    const summary = await collectGitDiffSummary(repo, modifiedPaths);

    assert.equal(summary.hasChanges, true);
    assert.deepEqual(filePaths(summary), ['bar.md', 'foo.md']);
    assert.equal(summary.totals.filesChanged, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('empty modifiedPaths reports no changes even when workspace is dirty', async () => {
  const repo = createRepo({ 'quux.md': 'before\n' });
  try {
    write(repo, 'quux.md', 'after\n');

    const summary = await collectGitDiffSummary(repo, new Set());

    assert.equal(summary.hasChanges, false);
    assert.deepEqual(summary.files, []);
    assert.equal(summary.totals.filesChanged, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('MultiEdit file_path is tracked as a modified path', async () => {
  const repo = createRepo({ 'foo.md': 'before\n' });
  try {
    write(repo, 'foo.md', 'after\n');
    const modifiedPaths = new Set();

    assert.equal(recordModifiedPathFromToolUse({ name: 'MultiEdit', input: { file_path: 'foo.md' } }, modifiedPaths), true);
    const summary = await collectGitDiffSummary(repo, modifiedPaths);

    assert.equal(summary.hasChanges, true);
    assert.deepEqual(filePaths(summary), ['foo.md']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('absolute modifiedPaths match relative git status paths after normalization', async () => {
  const repo = createRepo({ 'docs/foo.md': 'before\n' });
  try {
    const absolutePath = write(repo, 'docs/foo.md', 'after\n');
    const modifiedPaths = new Set([absolutePath]);

    const summary = await collectGitDiffSummary(repo, modifiedPaths);

    assert.equal(summary.hasChanges, true);
    assert.deepEqual(filePaths(summary), ['docs/foo.md']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

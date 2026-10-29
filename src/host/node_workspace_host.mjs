import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';

export function defaultWorkspaceRoot(root) { return path.resolve(root, '..'); }
export function defaultSessionDataDir(root) { return path.join(root, '.varina/data/sessions'); }

// Workspace identifiers and directory access belong to the host, not AgentService.
export class NodeWorkspaceHost {
  constructor(root) {
    this.root = path.resolve(root);
    this.realRoot = null;
  }

  async init() {
    this.realRoot = await realpath(this.root);
    if (!(await stat(this.realRoot)).isDirectory()) throw new Error('允许的工作区根路径不是目录');
    return this;
  }

  async resolve(requested) {
    const target = path.resolve(requested || this.root);
    const relative = path.relative(this.root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('会话工作区必须位于允许的工作区根目录内');
    const resolved = await realpath(target);
    const realRelative = path.relative(this.realRoot, resolved);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('目录通过符号链接越出了允许范围');
    if (!(await stat(resolved)).isDirectory()) throw new Error('选择的工作区不是目录');
    return resolved;
  }

  async browse(requested = null) {
    const current = await this.resolve(requested || this.realRoot);
    const entries = await readdir(current, { withFileTypes: true });
    const directories = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const resolved = await this.resolve(path.join(current, entry.name));
        directories.push({ name: entry.name, path: resolved, hidden: entry.name.startsWith('.') });
      } catch { /* omit inaccessible and escaping links */ }
    }
    const parent = current === this.realRoot ? null : await this.resolve(path.dirname(current));
    return { root: this.realRoot, current, parent, directories };
  }
}

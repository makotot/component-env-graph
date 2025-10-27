// biome-ignore lint/performance/noNamespaceImport: importing fs as a namespace
import * as fs from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: importing path as a namespace
import * as path from "node:path";
import type { Project } from "ts-morph";
import type { FileNode } from "./types.js";

export function addAllSourceFiles(
  project: Project,
  rootDir: string,
  globExclude: string[]
) {
  const glob = [
    path.join(rootDir, "**/*.ts"),
    path.join(rootDir, "**/*.tsx"),
    ...globExclude,
  ];
  project.addSourceFilesAtPaths(glob);
}

// biome-ignore lint/nursery/useMaxParams: Function has 5 parameters for clarity
export function refreshChangedFiles(
  project: Project,
  nodes: Map<string, FileNode>,
  changedFiles: string[],
  affectedFiles: Set<string>,
  excludes: RegExp
) {
  for (const changed of changedFiles) {
    if (excludes.test(changed)) {
      nodes.delete(changed);
      const existed = project.getSourceFile(changed);
      if (existed) {
        project.removeSourceFile(existed);
      }
      continue;
    }
    const sf = project.getSourceFile(changed);
    if (sf) {
      sf.refreshFromFileSystemSync();
    } else {
      try {
        project.addSourceFileAtPath(changed);
      } catch (_) {
        // ignore
      }
    }
    affectedFiles.add(changed);
  }
}

export function removeDeletedFiles(
  project: Project,
  nodes: Map<string, FileNode>
) {
  for (const sf of project.getSourceFiles()) {
    if (!fs.existsSync(sf.getFilePath())) {
      nodes.delete(sf.getFilePath());
      project.removeSourceFile(sf);
    }
  }
}

export function markAllFilesAsAffected(
  project: Project,
  affectedFiles: Set<string>
) {
  for (const sf of project.getSourceFiles()) {
    affectedFiles.add(sf.getFilePath());
  }
}

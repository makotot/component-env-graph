// biome-ignore assist/source/organizeImports: Importing path as a namespace
import { EventEmitter } from "node:events";
// biome-ignore lint/performance/noNamespaceImport: node:path cannot import with default import
import * as path from "node:path";
import { Project, type SourceFile } from "ts-morph";
import { DEFAULT_EXCLUDE, EXCLUDES } from "./constants.js";
import type { ComponentEnvGraphOptions, FileNode } from "./types.js";
import {
  hasUseClientDirective as analyzeHasUseClientDirective,
  getStaticImports as analyzeGetStaticImports,
} from "./analyze.js";
import {
  addAllSourceFiles as addAllSourceFilesFn,
  refreshChangedFiles as refreshChangedFilesFn,
  removeDeletedFiles as removeDeletedFilesFn,
  markAllFilesAsAffected as markAllFilesAsAffectedFn,
} from "./files.js";
import { computeComponentTypes } from "./classify.js";

/**
 * Component environment type classification.
 * - 'client': Entry or dependency with "use client" directive
 * - 'server': Server-only component
 * - 'universal': Referenced from both client and server
 */
export type {
  ComponentEnvGraphOptions,
  ComponentType,
  FileNode,
} from "./types.js";

/**
 * Builds and manages the dependency graph for a React Server Components (RSC) project.
 * UI components should use this class to retrieve file type information.
 */
export class ComponentEnvGraph {
  nodes: Map<string, FileNode> = new Map();
  project: Project;
  rootDir: string;

  private readonly globExclude: string[];
  private readonly _onDidUpdate = new EventEmitter();

  /**
   * Creates a new DependencyGraph instance.
   * @param rootDir Project root directory
   * @param options Optional configuration options.
   */
  constructor(rootDir: string, options?: ComponentEnvGraphOptions) {
    this.rootDir = rootDir;
    this.project = new Project({
      tsConfigFilePath:
        options?.tsConfigFilePath || path.join(rootDir, "tsconfig.json"),
      skipAddingFilesFromTsConfig: false,
    });

    const excludePatterns = [...DEFAULT_EXCLUDE, ...(options?.exclude || [])];
    this.globExclude = excludePatterns.map(
      (p) => `!${path.join(this.rootDir, p)}`
    );
  }

  /**
   * Rebuilds the dependency graph. If changedFiles is specified, only those files and their dependencies are re-parsed.
   * Otherwise, a full scan is performed.
   * @param changedFiles Array of changed file paths (if omitted, performs a full scan)
   */
  build(changedFiles?: string[]) {
    const filesToUpdate = this.updateProjectSourceFiles(changedFiles);
    this.updateFileNodes(filesToUpdate);

    const types = computeComponentTypes(this.nodes);
    for (const [fp, node] of this.nodes) {
      const type = types.get(fp);
      if (type) {
        node.type = type;
      }
    }
    this.fireDidUpdate();
  }

  /**
   * Registers a listener for dependency graph update events.
   * @param listener Callback function to invoke when the graph updates
   */
  onDidUpdate(listener: () => void) {
    this._onDidUpdate.on("update", listener);
  }

  /**
   * Determines if the first statement in the file is a "use client" directive.
   * Only the first statement is checked, per the React specification.
   * @param sf ts-morph SourceFile
   * @returns true if the file is a client component
   */
  private hasUseClientDirective(sf: SourceFile): boolean {
    return analyzeHasUseClientDirective(sf);
  }

  /**
   * Returns an array of absolute file paths statically imported or re-exported by the given file.
   * @param sf ts-morph SourceFile
   * @returns Array of imported/re-exported file paths
   */
  private getStaticImports(sf: SourceFile): string[] {
    return analyzeGetStaticImports(sf);
  }
  /**
   * Emits an update event to all registered listeners.
   */
  private fireDidUpdate() {
    this._onDidUpdate.emit("update");
  }

  /**
   * Updates the ts-morph project with the latest source files.
   * @param changedFiles Optional array of specific files that have changed.
   * @returns A Set of file paths that were affected and need their nodes updated.
   */
  private updateProjectSourceFiles(changedFiles?: string[]): Set<string> {
    const affectedFiles = new Set<string>();

    if (changedFiles && changedFiles.length > 0) {
      this.refreshChangedFiles(changedFiles, affectedFiles);
    } else {
      this.addAllSourceFiles();
    }

    this.removeDeletedFiles();

    if (!changedFiles || changedFiles.length === 0) {
      this.markAllFilesAsAffected(affectedFiles);
    }

    return affectedFiles;
  }

  private refreshChangedFiles(
    changedFiles: string[],
    affectedFiles: Set<string>
  ) {
    refreshChangedFilesFn(
      this.project,
      this.nodes,
      changedFiles,
      affectedFiles,
      EXCLUDES
    );
  }

  private addAllSourceFiles() {
    addAllSourceFilesFn(this.project, this.rootDir, this.globExclude);
  }

  private removeDeletedFiles() {
    removeDeletedFilesFn(this.project, this.nodes);
  }

  private markAllFilesAsAffected(affectedFiles: Set<string>) {
    markAllFilesAsAffectedFn(this.project, affectedFiles);
  }

  /**
   * Updates the internal `nodes` map for a given set of source files.
   * @param filesToUpdate A Set of file paths
   */
  private updateFileNodes(filesToUpdate: Set<string>) {
    for (const filePath of filesToUpdate) {
      const sf = this.project.getSourceFile(filePath);
      if (!sf) {
        this.nodes.delete(filePath);
        continue;
      }

      const isClient = this.hasUseClientDirective(sf);
      const imports = this.getStaticImports(sf);
      this.nodes.set(filePath, { filePath, isClient, imports });
    }
  }
}

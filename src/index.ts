import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Project, type SourceFile } from "ts-morph";

/**
 * Component environment type classification.
 * - 'client': Entry or dependency with "use client" directive
 * - 'server': Server-only component
 * - 'universal': Referenced from both client and server
 */
export type ComponentType = "client" | "server" | "universal";

/**
 * Node information for each file in the dependency graph.
 */
export type FileNode = {
  filePath: string;
  isClient: boolean;
  imports: string[];
  type?: ComponentType;
};

/**
 * Options for the ComponentEnvGraph constructor.
 */
export type ComponentEnvGraphOptions = {
  tsConfigFilePath?: string;
  exclude?: string[];
};

// Simple logger utility (enabled only if DEBUG is set)
function logDebug(...args: unknown[]) {
  if (process.env.DEBUG) {
    // biome-ignore lint/suspicious/noConsole: debugging log
    console.log("[DependencyGraph]", ...args);
  }
}

const EXCLUDES = /\.(stories|config|d|test|spec)\.(ts|tsx)$|__mocks__/;
// Returns true if the file should be excluded from analysis (config, d.ts, test, spec, stories, __mocks__)
function isExcludedFile(filePath: string): boolean {
  return EXCLUDES.test(filePath);
}

/**
 * Builds and manages the dependency graph for a React Server Components (RSC) project.
 * UI components should use this class to retrieve file type information.
 */
export class ComponentEnvGraph {
  private static readonly defaultExclude = [
    "**/*.stories.tsx",
    "**/*.stories.ts",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.d.ts",
    "**/*.config.ts",
    "**/*.config.tsx",
    "**/__mocks__/**",
    "node_modules/**",
    ".git/**",
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    "coverage/**",
  ];

  nodes: Map<string, FileNode> = new Map();
  project: Project;
  rootDir: string;
  private readonly globExclude: string[];

  private readonly _onDidUpdate = new EventEmitter();

  /**
   * Registers a listener for dependency graph update events.
   * @param listener Callback function to invoke when the graph updates
   */
  onDidUpdate(listener: () => void) {
    this._onDidUpdate.on("update", listener);
  }

  /**
   * Emits an update event to all registered listeners.
   */
  private fireDidUpdate() {
    this._onDidUpdate.emit("update");
  }

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

    const excludePatterns = [
      ...ComponentEnvGraph.defaultExclude,
      ...(options?.exclude || []),
    ];
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
    const filesToUpdate = this._updateProjectSourceFiles(changedFiles);
    this._updateFileNodes(filesToUpdate);

    this.classifyComponentTypes();
    for (const [fp, node] of this.nodes) {
      logDebug("node after classify", {
        filePath: fp,
        isClient: node.isClient,
        type: node.type,
      });
    }
    this.fireDidUpdate();
  }

  /**
   * Updates the ts-morph project with the latest source files.
   * @param changedFiles Optional array of specific files that have changed.
   * @returns A Set of file paths that were affected and need their nodes updated.
   */
  private _updateProjectSourceFiles(changedFiles?: string[]): Set<string> {
    const affectedFiles = new Set<string>();

    if (changedFiles && changedFiles.length > 0) {
      this._refreshChangedFiles(changedFiles, affectedFiles);
    } else {
      this._addAllSourceFiles();
    }

    this._removeDeletedFiles();

    if (!changedFiles || changedFiles.length === 0) {
      this._markAllFilesAsAffected(affectedFiles);
    }

    return affectedFiles;
  }

  private _refreshChangedFiles(
    changedFiles: string[],
    affectedFiles: Set<string>
  ) {
    for (const changed of changedFiles) {
      const sf = this.project.getSourceFile(changed);
      if (sf) {
        sf.refreshFromFileSystemSync();
      } else {
        try {
          this.project.addSourceFileAtPath(changed);
        } catch (_) {
          // Ignore if the file was deleted, etc.
        }
      }
      affectedFiles.add(changed);
    }
  }

  private _addAllSourceFiles() {
    const glob = [
      path.join(this.rootDir, "**/*.ts"),
      path.join(this.rootDir, "**/*.tsx"),
      ...this.globExclude,
    ];
    this.project.addSourceFilesAtPaths(glob);
  }

  private _removeDeletedFiles() {
    for (const sf of this.project.getSourceFiles()) {
      if (!fs.existsSync(sf.getFilePath())) {
        this.nodes.delete(sf.getFilePath());
        this.project.removeSourceFile(sf);
      }
    }
  }

  private _markAllFilesAsAffected(affectedFiles: Set<string>) {
    for (const sf of this.project.getSourceFiles()) {
      affectedFiles.add(sf.getFilePath());
    }
  }

  /**
   * Updates the internal `nodes` map for a given set of source files.
   * @param filesToUpdate A Set of file paths 크라운
   */
  private _updateFileNodes(filesToUpdate: Set<string>) {
    for (const filePath of filesToUpdate) {
      const sf = this.project.getSourceFile(filePath);
      if (!sf || isExcludedFile(filePath)) {
        this.nodes.delete(filePath);
        continue;
      }

      const isClient = this.hasUseClientDirective(sf);
      const imports = this.getStaticImports(sf);
      this.nodes.set(filePath, { filePath, isClient, imports });
      logDebug("node (updated)", { filePath, isClient, imports });
    }
  }

  /**
   * Classifies the type (client/server/universal) of all nodes.
   * - client: Entry point or dependency with a "use client" directive
   * - server: Not reachable from any client entry
   * - universal: Imported from both client and server components
   */
  classifyComponentTypes() {
    const clientEntries = this.getClientEntries();
    const clientReachable = this.getClientReachable(clientEntries);
    this.setNodeTypes(clientReachable);
    const importers = this.collectImporters();
    this.setUniversalTypes(importers);
    // No 'other' classification: config, d.ts, test, spec, stories, __mocks__, etc. are not handled here.
  }

  private getClientEntries(): string[] {
    return Array.from(this.nodes.values())
      .filter((n) => n.isClient)
      .map((n) => n.filePath);
  }

  private getClientReachable(clientEntries: string[]): Set<string> {
    const clientReachable = new Set<string>();
    const visit = (fp: string) => {
      if (clientReachable.has(fp)) {
        return;
      }
      clientReachable.add(fp);
      const node = this.nodes.get(fp);
      if (!node) {
        return;
      }
      for (const imp of node.imports) {
        if (this.nodes.has(imp)) {
          visit(imp);
        }
      }
    };
    for (const entry of clientEntries) {
      visit(entry);
    }
    return clientReachable;
  }

  private setNodeTypes(clientReachable: Set<string>) {
    for (const [fp, node] of this.nodes) {
      if (clientReachable.has(fp)) {
        node.type = "client";
      } else {
        node.type = "server";
      }
    }
  }

  private collectImporters(): Map<string, Set<string>> {
    const importers = new Map<string, Set<string>>();
    for (const [fp, node] of this.nodes) {
      for (const imp of node.imports) {
        if (!importers.has(imp)) {
          importers.set(imp, new Set());
        }
        importers.get(imp)?.add(fp);
      }
    }
    return importers;
  }

  private setUniversalTypes(importers: Map<string, Set<string>>) {
    for (const [fp, node] of this.nodes) {
      if (node.isClient) {
        continue;
      }
      const from = importers.get(fp);
      if (!from) {
        continue;
      }
      if (this.isUniversalType(from)) {
        node.type = "universal";
      }
    }
  }

  private isUniversalType(importers: Set<string>): boolean {
    let hasClient = false;
    let hasServer = false;
    for (const importer of importers) {
      const t = this.nodes.get(importer)?.type;
      if (t === "client") {
        hasClient = true;
      }
      if (t === "server") {
        hasServer = true;
      }
      if (hasClient && hasServer) {
        return true;
      }
    }
    return false;
  }

  /**
   * Determines if the first statement in the file is a "use client" directive.
   * Only the first statement is checked, per the React specification.
   * @param sf ts-morph SourceFile
   * @returns true if the file is a client component
   */
  hasUseClientDirective(sf: SourceFile): boolean {
    // Only check the first statement for the exact 'use client' directive (no semicolon required)
    const stmts = sf.getStatements();
    if (stmts.length > 0) {
      const stmt = stmts[0];
      if (stmt && stmt.getKindName() === "ExpressionStatement") {
        const text = stmt.getText().trim();
        // Accept both 'use client' and "use client" (with or without semicolon)
        if (
          text === "'use client'" ||
          text === '"use client"' ||
          text === "'use client';" ||
          text === '"use client";'
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Returns an array of absolute file paths statically imported or re-exported by the given file.
   * @param sf ts-morph SourceFile
   * @returns Array of imported/re-exported file paths
   */
  getStaticImports(sf: SourceFile): string[] {
    // import ... from '...'
    const importFiles = sf
      .getImportDeclarations()
      .map((imp) => {
        const f = imp.getModuleSpecifierSourceFile();
        return f ? f.getFilePath().toString() : undefined;
      })
      .filter((f): f is string => typeof f === "string");
    // export * from '...'; export { ... } from '...';
    const exportFiles = sf
      .getExportDeclarations()
      .map((exp) => {
        const f = exp.getModuleSpecifierSourceFile?.();
        return f ? f.getFilePath().toString() : undefined;
      })
      .filter((f): f is string => typeof f === "string");
    return [...importFiles, ...exportFiles];
  }
}

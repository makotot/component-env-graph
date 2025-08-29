import { Project, SourceFile } from 'ts-morph';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as fs from 'fs';

/**
 * Component environment type classification.
 * - 'client': Entry or dependency with "use client" directive
 * - 'server': Server-only component
 * - 'universal': Referenced from both client and server
 */
export type ComponentType = 'client' | 'server' | 'universal';

/**
 * Node information for each file in the dependency graph.
 */
export interface FileNode {
    filePath: string;
    isClient: boolean;
    imports: string[];
    type?: ComponentType;
}

/**
 * Options for the ComponentEnvGraph constructor.
 */
export interface ComponentEnvGraphOptions {
    tsConfigFilePath?: string;
    exclude?: string[];
}

// Simple logger utility (enabled only if DEBUG is set)
function logDebug(...args: any[]) {
    if (process.env.DEBUG) {
        // eslint-disable-next-line no-console
        console.log('[DependencyGraph]', ...args);
    }
}

// Returns true if the file should be excluded from analysis (config, d.ts, test, spec, stories, __mocks__)
function isExcludedFile(filePath: string): boolean {
    return /\.(stories|config|d|test|spec)\.(ts|tsx)$|__mocks__/.test(filePath);
}

/**
 * Builds and manages the dependency graph for a React Server Components (RSC) project.
 * UI components should use this class to retrieve file type information.
 */
export class ComponentEnvGraph {
    private static readonly defaultExclude = [
        '**/*.stories.tsx',
        '**/*.stories.ts',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
        '**/*.config.ts',
        '**/*.config.tsx',
        '**/__mocks__/**',
        'node_modules/**',
        '.git/**',
        '.next/**',
        'dist/**',
        'out/**',
        'build/**',
        'coverage/**',
    ];

    nodes: Map<string, FileNode> = new Map();
    project: Project;
    rootDir: string;
    private readonly globExclude: string[];

    private _onDidUpdate = new EventEmitter();

    /**
     * Registers a listener for dependency graph update events.
     * @param listener Callback function to invoke when the graph updates
     */
    onDidUpdate(listener: () => void) {
        this._onDidUpdate.on('update', listener);
    }

    /**
     * Emits an update event to all registered listeners.
     */
    private fireDidUpdate() {
        this._onDidUpdate.emit('update');
    }

    /**
     * Creates a new DependencyGraph instance.
     * @param rootDir Project root directory
     * @param options Optional configuration options.
     */
    constructor(rootDir: string, options?: ComponentEnvGraphOptions) {
        this.rootDir = rootDir;
        this.project = new Project({
            tsConfigFilePath: options?.tsConfigFilePath || path.join(rootDir, 'tsconfig.json'),
            skipAddingFilesFromTsConfig: false,
        });

        const excludePatterns = [...ComponentEnvGraph.defaultExclude, ...(options?.exclude || [])];
        this.globExclude = excludePatterns.map(p => '!' + path.join(this.rootDir, p));
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
            logDebug('node after classify', { filePath: fp, isClient: node.isClient, type: node.type });
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
            // Partial update: refresh only the changed files
            for (const changed of changedFiles) {
                const sf = this.project.getSourceFile(changed);
                if (sf) {
                    sf.refreshFromFileSystemSync();
                } else {
                    try {
                        this.project.addSourceFileAtPath(changed);
                    } catch (e) {
                        // Ignore if the file was deleted, etc.
                    }
                }
                affectedFiles.add(changed);
            }
        } else {
            // Full scan: add new files and remove old ones
            const glob = [
                path.join(this.rootDir, '**/*.ts'),
                path.join(this.rootDir, '**/*.tsx'),
                ...this.globExclude,
            ];
            this.project.addSourceFilesAtPaths(glob);
        }

        // Sync the project with the file system to remove deleted files
        this.project.getSourceFiles().forEach(sf => {
            if (!fs.existsSync(sf.getFilePath())) {
                this.nodes.delete(sf.getFilePath());
                this.project.removeSourceFile(sf);
            }
        });

        // For a full scan, all files are considered affected
        if (!changedFiles || changedFiles.length === 0) {
            this.project.getSourceFiles().forEach(sf => affectedFiles.add(sf.getFilePath()));
        }

        return affectedFiles;
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
            logDebug('node (updated)', { filePath, isClient, imports });
        }
    }

    /**
     * Classifies the type (client/server/universal) of all nodes.
     * - client: Entry point or dependency with a "use client" directive
     * - server: Not reachable from any client entry
     * - universal: Imported from both client and server components
     */
    classifyComponentTypes() {
        // 1. client entry points
        const clientEntries = Array.from(this.nodes.values()).filter(n => n.isClient).map(n => n.filePath);
        // 2. Enumerate nodes reachable from client
        const clientReachable = new Set<string>();
        const visit = (fp: string) => {
            if (clientReachable.has(fp)) { return; }
            clientReachable.add(fp);
            const node = this.nodes.get(fp);
            if (!node) { return; }
            for (const imp of node.imports) {
                if (this.nodes.has(imp)) { visit(imp); }
            }
        };
        for (const entry of clientEntries) { visit(entry); }
        // 3. Set type for each node
        for (const [fp, node] of this.nodes) {
            if (clientReachable.has(fp)) {
                node.type = 'client';
            } else {
                node.type = 'server';
            }
        }
        // 4. universal: imported from both client and server (single pass)
        const importers = new Map<string, Set<string>>();
        // 1st pass: collect importers and check universal in one go
        for (const [fp, node] of this.nodes) {
            for (const imp of node.imports) {
                if (!importers.has(imp)) { importers.set(imp, new Set()); }
                importers.get(imp)!.add(fp);
            }
        }
        for (const [fp, node] of this.nodes) {
            if (node.isClient) { continue; }

            const from = importers.get(fp);
            if (!from) { continue; }

            let hasClient = false, hasServer = false;
            for (const importer of from) {
                const t = this.nodes.get(importer)?.type;
                if (t === 'client') { hasClient = true; }
                if (t === 'server') { hasServer = true; }
                if (hasClient && hasServer) {
                    node.type = 'universal';
                    break;
                }
            }
        }
        // No 'other' classification: config, d.ts, test, spec, stories, __mocks__, etc. are not handled here.
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
            if (stmt && stmt.getKindName() === 'ExpressionStatement') {
                const text = stmt.getText().trim();
                // Accept both 'use client' and "use client" (with or without semicolon)
                if (text === "'use client'" || text === '"use client"' || text === "'use client';" || text === '"use client";') {
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
        const importFiles = sf.getImportDeclarations()
            .map(imp => {
                const f = imp.getModuleSpecifierSourceFile();
                return f ? f.getFilePath().toString() : undefined;
            })
            .filter((f): f is string => typeof f === 'string');
        // export * from '...'; export { ... } from '...';
        const exportFiles = sf.getExportDeclarations()
            .map(exp => {
                const f = exp.getModuleSpecifierSourceFile?.();
                return f ? f.getFilePath().toString() : undefined;
            })
            .filter((f): f is string => typeof f === 'string');
        return [...importFiles, ...exportFiles];
    }
}

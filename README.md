# Component Env Graph

[![npm version](https://badge.fury.io/js/%40makotot%2Fcomponent-env-graph.svg)](https://badge.fury.io/js/%40makotot%2Fcomponent-env-graph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A library to statically analyze component dependencies in a React Server Components (RSC) project and determine their execution environment (`client`, `server`, or `universal`).

It parses your TypeScript/JavaScript project, builds a dependency graph, and classifies each component based on whether it's part of a `"use client"` module tree.

## Features

-   **Environment Classification**: Classifies components into `client`, `server`, or `universal`.
-   **Fast Incremental Updates**: Rebuilds the graph quickly when files change, avoiding full scans.
-   **TypeScript First**: Heavily relies on [ts-morph](https://ts-morph.com/) for robust static analysis of TypeScript code.
-   **Customizable**: Allows custom `tsconfig.json` paths and file exclusion patterns.

## Installation

```bash
npm install @makotot/component-env-graph
```

Or with pnpm:

```bash
pnpm add @makotot/component-env-graph
```

## Basic Usage

This library is often used with a file watcher like `chokidar` to keep the dependency graph up-to-date as you code.

```typescript
import { ComponentEnvGraph } from '@makotot/component-env-graph';
import chokidar from 'chokidar';

// 1. Initialize the graph with your project's root directory
const graph = new ComponentEnvGraph('/path/to/your/nextjs-project');

// 2. Perform the initial full-scan build
console.log('Building initial dependency graph...');
graph.build();
console.log('Initial build complete!');

// 3. Access the analysis results from the `.nodes` property
const fileInfo = graph.nodes.get('/path/to/your/nextjs-project/src/app/page.tsx');
if (fileInfo) {
    console.log(`page.tsx is a ${fileInfo.type} component.`);
}

// 4. (Optional) Subscribe to update events
graph.onDidUpdate(() => {
    console.log('Graph has been updated!');
    // You can re-render your UI or perform other actions here
    // e.g., redrawUI(graph.nodes);
});

// 5. Watch for file changes and perform incremental updates
const watcher = chokidar.watch('/path/to/your/nextjs-project/src', {
    ignored: /node_modules/,
    persistent: true,
});

const handleFileChange = (filePath: string) => {
    console.log(`File changed: ${filePath}. Rebuilding graph...`);
    // Pass an array of changed files to `build()` for a fast incremental update
    graph.build([filePath]);
};

watcher
    .on('add', handleFileChange)
    .on('change', handleFileChange)
    .on('unlink', handleFileChange);
```

## API Reference

### `new ComponentEnvGraph(rootDir, options?)`

Creates a new graph instance.

-   `rootDir` (string, required): The absolute path to the root of the project to be analyzed.
-   `options` (object, optional):
    -   `tsConfigFilePath` (string): Absolute path to a custom `tsconfig.json`. Defaults to `{rootDir}/tsconfig.json`.
    -   `exclude` (string[]): An array of glob patterns to exclude from the analysis, in addition to the defaults.

### `.build(changedFiles?)`

Builds or updates the dependency graph.

-   `changedFiles` (string[], optional): An array of absolute paths to files that have been added, changed, or deleted. If provided, performs a fast incremental update. If omitted, performs a full scan of the entire project.

### `.nodes`

A `Map<string, FileNode>` containing the analysis result for each file in the graph. The key is the absolute file path.

The `FileNode` object has the following structure:

```typescript
interface FileNode {
    filePath: string;      // Absolute path to the file
    isClient: boolean;     // True if the file contains a "use client" directive
    imports: string[];     // Array of absolute paths to other files this file imports
    type?: 'client' | 'server' | 'universal'; // The classified execution environment
}
```

### `.onDidUpdate(listener)`

Registers a callback function to be invoked whenever the graph is updated by the `.build()` method.

-   `listener` (() => void): The function to call on updates.

## License

[MIT](https://opensource.org/licenses/MIT)

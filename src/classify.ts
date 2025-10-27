import type { ComponentType, FileNode } from "./types.js";

// Pure computation: returns a mapping of filePath -> ComponentType without mutating nodes
export function computeComponentTypes(
  nodes: ReadonlyMap<string, FileNode>
): Map<string, ComponentType> {
  const clientEntries = getClientEntries(nodes);
  const clientReachable = getClientReachable(nodes, clientEntries);
  const types = initNodeTypes(nodes, clientReachable);
  const importers = collectImporters(nodes);
  const universalSet = computeUniversalSet(nodes, importers, types);
  for (const fp of universalSet) {
    types.set(fp, "universal");
  }
  return types;
}

function getClientEntries(nodes: ReadonlyMap<string, FileNode>): string[] {
  return Array.from(nodes.values())
    .filter((n) => n.isClient)
    .map((n) => n.filePath);
}

function getClientReachable(
  nodes: ReadonlyMap<string, FileNode>,
  clientEntries: string[]
): Set<string> {
  const clientReachable = new Set<string>();
  const visit = (fp: string) => {
    if (clientReachable.has(fp)) {
      return;
    }
    clientReachable.add(fp);
    const node = nodes.get(fp);
    if (!node) {
      return;
    }
    for (const imp of node.imports) {
      if (nodes.has(imp)) {
        visit(imp);
      }
    }
  };
  for (const entry of clientEntries) {
    visit(entry);
  }
  return clientReachable;
}

function initNodeTypes(
  nodes: ReadonlyMap<string, FileNode>,
  clientReachable: Set<string>
): Map<string, ComponentType> {
  const types = new Map<string, ComponentType>();
  for (const fp of nodes.keys()) {
    types.set(fp, clientReachable.has(fp) ? "client" : "server");
  }
  return types;
}

function collectImporters(
  nodes: ReadonlyMap<string, FileNode>
): Map<string, Set<string>> {
  const importers = new Map<string, Set<string>>();
  for (const [fp, node] of nodes) {
    for (const imp of node.imports) {
      if (!importers.has(imp)) {
        importers.set(imp, new Set());
      }
      importers.get(imp)?.add(fp);
    }
  }
  return importers;
}

function computeUniversalSet(
  nodes: ReadonlyMap<string, FileNode>,
  importers: Map<string, Set<string>>,
  types: ReadonlyMap<string, ComponentType>
): Set<string> {
  const universal = new Set<string>();
  for (const [fp, node] of nodes) {
    if (node.isClient) {
      continue;
    }
    const from = importers.get(fp);
    if (!from) {
      continue;
    }
    if (isUniversalType(types, from)) {
      universal.add(fp);
    }
  }
  return universal;
}

function isUniversalType(
  types: ReadonlyMap<string, ComponentType>,
  importers: Set<string>
): boolean {
  let hasClient = false;
  let hasServer = false;
  for (const importer of importers) {
    const t = types.get(importer);
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

import type { SourceFile } from "ts-morph";

export function hasUseClientDirective(sf: SourceFile): boolean {
  const stmts = sf.getStatements();
  if (stmts.length > 0) {
    const stmt = stmts[0];
    if (stmt && stmt.getKindName() === "ExpressionStatement") {
      const text = stmt.getText().trim();
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

export function getStaticImports(sf: SourceFile): string[] {
  const importFiles = sf
    .getImportDeclarations()
    .map((imp) => {
      const f = imp.getModuleSpecifierSourceFile();
      return f ? f.getFilePath().toString() : undefined;
    })
    .filter((f): f is string => typeof f === "string");

  const exportFiles = sf
    .getExportDeclarations()
    .map((exp) => {
      const f = exp.getModuleSpecifierSourceFile?.();
      return f ? f.getFilePath().toString() : undefined;
    })
    .filter((f): f is string => typeof f === "string");

  return [...importFiles, ...exportFiles];
}


// biome-ignore lint/performance/noNamespaceImport: node:fs cannot import with default import
import * as fs from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: node:os cannot import with default import
import * as os from "node:os";
// biome-ignore lint/performance/noNamespaceImport: node:path cannot import with default import
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComponentEnvGraph } from "./index.js";

describe("ComponentEnvGraph", () => {
  let tempDir: string;
  let graph: ComponentEnvGraph;

  function write(file: string, content: string) {
    const fullPath = path.join(tempDir, file);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content);
  }
  function remove(file: string) {
    fs.rmSync(path.join(tempDir, file), { force: true });
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-graph-test-"));
    write(
      "tsconfig.json",
      '{ "compilerOptions": { "jsx": "react" }, "include": ["**/*"] }'
    );
    graph = new ComponentEnvGraph(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  type TypeCase = {
    name: string;
    files: Record<string, string>;
    expect: Record<string, string | undefined>;
  };

  const typeCases: TypeCase[] = [
    {
      name: "client component (use client)",
      files: { "client.tsx": '"use client"; export const C = () => null;' },
      expect: { "client.tsx": "client" },
    },
    {
      name: "shared dep with mixed clients (a->b, c->b; only a is client)",
      files: {
        "a.tsx": '"use client"; import { B } from "./b"; export const A = () => null;',
        "c.tsx": 'import { B } from "./b"; export const C = () => null;',
        "b.tsx": 'export const B = () => null;',
      },
      expect: { "a.tsx": "client", "b.tsx": "universal", "c.tsx": "server" },
    },
    {
      name: "server component (no use client)",
      files: { "server.tsx": "export const S = () => null;" },
      expect: { "server.tsx": "server" },
    },
    {
      name: "universal component",
      files: {
        "client.tsx":
          '"use client"; import { Sh } from "./universal"; export const C = () => null;',
        "server.tsx":
          'import { Sh } from "./universal"; export const S = () => null;',
        "universal.tsx": "export const Sh = () => null;",
      },
      expect: { "universal.tsx": "universal" },
    },
    {
      name: "client propagation across chain (a -> b -> c)",
      files: {
        "a.tsx":
          '"use client"; import { B } from "./b"; export const A = () => null;',
        "b.tsx": 'import { C } from "./c"; export const B = () => null;',
        "c.tsx": "export const C = () => null;",
      },
      expect: { "a.tsx": "client", "b.tsx": "client", "c.tsx": "client" },
    },
    {
      name: "other: config, d.ts, test, spec, __mocks__",
      files: {
        "foo.config.ts": "export const x = 1;",
        "foo.d.ts": "export type X = number;",
        "foo.test.ts": "export const t = 1;",
        "foo.spec.ts": "export const s = 1;",
        "__mocks__/bar.ts": "export const m = 1;",
      },
      expect: {
        "foo.config.ts": undefined,
        "foo.d.ts": undefined,
        "foo.test.ts": undefined,
        "foo.spec.ts": undefined,
        "__mocks__/bar.ts": undefined,
      },
    },

    {
      name: "handles circular dependencies",
      files: {
        "a.tsx": 'import { B } from "./b"; export const A = () => null;',
        "b.tsx": 'import { A } from "./a"; export const B = () => null;',
      },
      expect: { "a.tsx": "server", "b.tsx": "server" },
    },
    {
      name: "handles import path case and extension variations",
      files: {
        "Upper.tsx": "export const U = 1;",
        "importer.tsx": 'import { U } from "./Upper"; export const I = 1;',
      },
      expect: { "Upper.tsx": "server", "importer.tsx": "server" },
    },
    {
      name: "re-exported dependency from index.ts with use client",
      files: {
        "index.ts": '"use client"; export * from "./Button";',
        "Button.tsx": "export const Button = () => null;",
      },
      expect: {
        "index.ts": "client",
        "Button.tsx": "client",
      },
    },
  ];

  for (const { name, files, expect: expected } of typeCases) {
    it(name, () => {
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(tempDir, filePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, content);
      }
      graph.build();
      const expectTypesEntries = Object.entries(expected).filter(
        ([, v]) => v !== undefined
      );
      const expectAbsent = Object.entries(expected)
        .filter(([, v]) => v === undefined)
        .map(([k]) => k);
      for (const [filePath, expectedType] of expectTypesEntries) {
        const node = graph.nodes.get(path.join(tempDir, filePath));
        expect(node?.type, `${filePath} should be ${expectedType}`).toBe(
          expectedType
        );
      }
      for (const filePath of expectAbsent) {
        const node = graph.nodes.get(path.join(tempDir, filePath));
        expect(node, `${filePath} should be removed from nodes`).toBeFalsy();
      }
    });
  }

  // write operation scenarios
  it.each([
    {
      name: "updates type when use client is added/removed",
      initial: { "server.tsx": "export const S = () => null;" },
      writes: [
        {
          filePath: "server.tsx",
          content: '"use client"; export const S = () => null;',
          changedFiles: ["server.tsx"],
        },
        {
          filePath: "server.tsx",
          content: "export const S = () => null;",
          changedFiles: ["server.tsx"],
        },
      ],
      expectTypes: { "server.tsx": "server" },
    },
  ])("$name", ({ initial, writes, expectTypes }) => {
    for (const [file, content] of Object.entries(initial)) {
      write(file, content);
    }
    graph.build();
    for (const w of writes) {
      write(w.filePath, w.content);
      const changed = (w.changedFiles || [w.filePath]).map((f) =>
        path.join(tempDir, f)
      );
      graph.build(changed);
    }
    for (const [file, t] of Object.entries(expectTypes)) {
      const node = graph.nodes.get(path.join(tempDir, file));
      expect(node?.type, `${file} should be ${t}`).toBe(t);
    }
  });

  // remove operation scenarios
  it.each([
    {
      name: "removes node when file is deleted",
      initial: { "shared.tsx": "export const Sh = () => null;" },
      removes: [{ filePath: "shared.tsx", changedFiles: ["shared.tsx"] }],
      expectAbsent: ["shared.tsx"],
    },
  ])("$name", ({ initial, removes, expectAbsent }) => {
    for (const [file, content] of Object.entries(initial)) {
      write(file, content);
    }
    graph.build();
    for (const r of removes) {
      remove(r.filePath);
      const changed = (r.changedFiles || [r.filePath]).map((f) =>
        path.join(tempDir, f)
      );
      graph.build(changed);
    }
    for (const file of expectAbsent as string[]) {
      const node = graph.nodes.get(path.join(tempDir, file));
      expect(node, `${file} should be removed from nodes`).toBeFalsy();
    }
  });
});

describe("ComponentEnvGraph tsConfigFilePath option", () => {
  it("uses custom tsconfig.json path if provided", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-graph-test-"));
    const customTsconfigPath = path.join(tempDir, "custom-tsconfig.json");
    fs.writeFileSync(
      customTsconfigPath,
      '{ "compilerOptions": { "jsx": "react" }, "include": ["**/*"] }'
    );
    fs.writeFileSync(
      path.join(tempDir, "client.tsx"),
      '"use client"; export const C = () => null;'
    );
    const graph = new ComponentEnvGraph(tempDir, {
      tsConfigFilePath: customTsconfigPath,
    });
    graph.build();
    const node = graph.nodes.get(path.join(tempDir, "client.tsx"));
    expect(node).toBeTruthy();
    expect(node?.type).toBe("client");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("defaults to <rootDir>/tsconfig.json if no path is provided", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-graph-test-"));
    fs.writeFileSync(
      path.join(tempDir, "tsconfig.json"),
      '{ "compilerOptions": { "jsx": "react" }, "include": ["**/*"] }'
    );
    fs.writeFileSync(
      path.join(tempDir, "client.tsx"),
      '"use client"; export const C = () => null;'
    );
    const graph = new ComponentEnvGraph(tempDir);
    graph.build();
    const node = graph.nodes.get(path.join(tempDir, "client.tsx"));
    expect(node).toBeTruthy();
    expect(node?.type).toBe("client");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

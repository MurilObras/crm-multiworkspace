// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const fonts = path.join(root, "app/fonts");
const manifest = JSON.parse(fs.readFileSync(path.join(fonts, "manifest.json"), "utf8")) as {
  files: Array<{ file: string; sha256: string }>;
};

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

describe("fontes locais — o build independe do Google Fonts", () => {
  it("nenhum módulo do app reintroduz o carregador de fontes pela rede", () => {
    const remote: string[] = [];
    for (const file of sources(path.join(root, "app"))) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
      );
      function visit(node: ts.Node) {
        if (ts.isStringLiteral(node) && node.text === "next/font/google") remote.push(file);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(remote).toEqual([]);
  });

  it("todos os arquivos locais referenciados acompanham o manifest e têm conteúdo íntegro", () => {
    const referenced = new Set<string>();
    for (const relative of ["app/layout.tsx", "app/design/lib/fonts.ts"]) {
      const file = path.join(root, relative);
      const source = fs.readFileSync(file, "utf8");
      for (const [, src] of source.matchAll(/["']([^"']+\.woff2)["']/g)) {
        const resolved = path.resolve(path.dirname(file), src!);
        expect(path.dirname(resolved)).toBe(fonts);
        referenced.add(path.basename(resolved));
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    expect([...referenced].sort()).toEqual(manifest.files.map((file) => file.file).sort());
    for (const entry of manifest.files) {
      const bytes = fs.readFileSync(path.join(fonts, entry.file));
      expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
      expect(bytes.readUInt32BE(8)).toBe(bytes.length);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    }
  });
});

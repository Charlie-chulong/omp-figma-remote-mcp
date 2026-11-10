import ts from 'typescript';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });
for (const name of ['index', 'oauth-callback']) {
  const source = new URL(`${name}.ts`, root);
  const result = ts.transpileModule(await readFile(source, 'utf8'), {
    fileName: fileURLToPath(source),
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  const errors = result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => fileURLToPath(root),
    getNewLine: () => '\n',
  }));
  await writeFile(new URL(`dist/${name}.js`, root), result.outputText);
}
console.log('Built Node ESM entry and OAuth callback. Host SDK imports remain external.');

#!/usr/bin/env node

/**
 * Builds the standalone preview_ui bundle and its omp custom tool.
 *
 * The bundle (preview-ui.rbxm) is the preview core (studio-plugin/src/modules/preview/UiPreview.ts), the few
 * plugin modules it imports, the roblox-ts runtime, @rbxts/services and the story renderer, under one Folder.
 * It contains no plugin bootstrap: the omp tool (omp-tool/preview_ui/index.ts) imports it into Studio through a
 * released robloxstudio-mcp server's import_rbxm tool and drives it through execute_luau.
 *
 * Requires a built studio-plugin/MCPPlugin.rbxmx (npm run build:plugin:artifact), plus rojo and lune on PATH.
 *
 *   node scripts/build-preview-bundle.mjs [--out <dir>] [--install]
 *
 * --out defaults to .local/preview-ui-tool; --install writes to ~/.omp/agent/tools/preview_ui instead.
 * The output directory receives index.ts, preview-ui.rbxm, preview-ui.json (bundle version) and NOTICE.
 */

import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginArtifact = join(rootDir, 'studio-plugin', 'MCPPlugin.rbxmx');
const toolSource = join(rootDir, 'omp-tool', 'preview_ui', 'index.ts');
const BUNDLE_NAME = 'PreviewUiBundle';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const outDir = process.argv.includes('--install')
  ? join(homedir(), '.omp', 'agent', 'tools', 'preview_ui')
  : argValue('--out') ?? join(rootDir, '.local', 'preview-ui-tool');

if (!existsSync(pluginArtifact)) {
  console.error(`Missing ${pluginArtifact}. Run "npm run build:plugin:artifact" first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'preview-bundle-'));
try {
  // Rojo turns the XML plugin model into a binary model Lune can read.
  const project = join(work, 'plugin.project.json');
  writeFileSync(project, JSON.stringify({ name: 'Plugin', tree: { $path: pluginArtifact } }));
  const pluginModel = join(work, 'plugin.rbxm');
  execFileSync('rojo', ['build', project, '-o', pluginModel], { stdio: ['ignore', 'ignore', 'inherit'] });

  mkdirSync(outDir, { recursive: true });
  const bundlePath = join(outDir, 'preview-ui.rbxm');
  const output = execFileSync(
    'lune',
    ['run', join(rootDir, 'scripts', 'preview-bundle.luau'), pluginModel, bundlePath, BUNDLE_NAME],
    { encoding: 'utf8' },
  ).trim();
  const [version, moduleCount] = output.split(/\s+/);
  const { version: packageVersion } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  writeFileSync(join(outDir, 'preview-ui.json'), `${JSON.stringify({ name: BUNDLE_NAME, version, sourcePackageVersion: packageVersion }, null, 2)}\n`);
  copyFileSync(toolSource, join(outDir, 'index.ts'));
  copyFileSync(join(rootDir, 'packages', 'robloxstudio-mcp', 'NOTICE'), join(outDir, 'NOTICE'));
  console.log(`Built preview_ui tool ${version} (${moduleCount} modules) in ${outDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

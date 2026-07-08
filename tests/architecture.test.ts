/**
 * Guards the engine/app boundary — the repo's core structural invariant. The
 * engine layers (parsing, timing, notes, song, gameplay, audio, input, the
 * play-loop) import no React and no UI code, so they stay unit-testable in Node
 * and could run headless. This test fails the build if that boundary regresses,
 * rather than leaving it to code review to notice.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Engine layers that must stay free of React / UI dependencies. */
const ENGINE_DIRS = ['notes', 'timing', 'parse', 'song', 'gameplay', 'audio', 'input', 'game'];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Match the module specifier of every static/dynamic import + re-export. */
function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) specs.push(m[1] ?? m[2]);
  return specs;
}

describe('engine/app boundary', () => {
  for (const layer of ENGINE_DIRS) {
    it(`src/${layer} imports no React or UI code`, () => {
      const offenders: string[] = [];
      for (const file of tsFiles(join(SRC, layer))) {
        for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
          const bad =
            spec === 'react' ||
            spec === 'react-dom' ||
            spec.startsWith('react/') ||
            spec.startsWith('react-dom/') ||
            /(^|\/)ui\//.test(spec) ||
            spec.endsWith('/ui');
          if (bad) offenders.push(`${file.slice(SRC.length + 1)} -> ${spec}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});

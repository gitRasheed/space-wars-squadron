import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const THREE_ONLY_IN_RENDER = {
  group: ['three', 'three/*'],
  message: 'Three.js belongs only in src/render/. Keep simulation and input pure.',
};
const NO_TOOLS_FROM_APP = {
  group: ['**/tools/*', '../tools/*', '../../tools/*'],
  message: 'Keep src/ and tests/ decoupled from standalone MIT packages in tools/.',
};

// typescript-eslint disables no-undef for .ts, so browser globals are banned by name instead.
const BROWSER_GLOBALS_BANNED_IN_SIM = [
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'setInterval',
  'HTMLElement',
  'HTMLCanvasElement',
  'AudioContext',
].map((name) => ({ name, message: 'src/sim/ is a pure, deterministic simulation: no DOM or browser APIs.' }));

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-test/**',
      'artifacts/**',
      'node_modules/**',
      'formal/states/**',
      'scratch/**',
      'tools/*/node_modules/**',
      'tools/*/dist/**',
      'tools/*/dist-test/**',
    ],
  },
  { ...js.configs.recommended, ignores: ['tools/**'] },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-imports': ['error', { patterns: [THREE_ONLY_IN_RENDER, NO_TOOLS_FROM_APP] }],
    },
  },
  {
    files: ['src/render/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_TOOLS_FROM_APP] }],
    },
  },
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...BROWSER_GLOBALS_BANNED_IN_SIM],
    },
  },
  {
    // tools/ packages are standalone: only this boundary rule applies to them from the root.
    files: ['tools/*/src/**/*.ts', 'tools/*/tests/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/src/sim/*', '**/src/render/*', '**/src/audio/*', '**/src/input/*', '../../../src/*', '../../../../src/*'],
              message: 'tools/ packages are standalone MIT tools and must not import the game in src/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.js', '*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
);

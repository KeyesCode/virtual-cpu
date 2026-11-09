import { builtinModules } from 'node:module';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const portableImportMessage =
  'cpu-core, shared and research-core must not depend on Node.js or React APIs.';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '.fredrin/', '.agents/', '.claude/', '.research/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: [
      '*.js',
      '*.ts',
      'scripts/**/*.ts',
      'apps/cli/**/*.ts',
      'apps/web/vite.config.ts',
      'apps/research-api/**/*.ts',
      'apps/research-worker/**/*.ts',
      'apps/research-dashboard/vite.config.ts',
      'packages/rtl-tools/**/*.ts',
      'packages/accelerator-reference/**/*.ts',
      'packages/research-core/**/*.ts',
      'packages/eda-adapters/**/*.ts',
      'packages/artifact-storage/**/*.ts',
      'packages/research-agents/**/*.ts',
      'packages/experiment-runner/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'apps/research-dashboard/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // A NestJS module is an empty class that exists for its decorator.
    files: ['apps/research-api/**/*.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }] },
  },
  {
    // cpu-core, shared and research-core must run anywhere: no Node built-ins and no React.
    files: [
      'packages/cpu-core/**/*.ts',
      'packages/shared/**/*.ts',
      'packages/research-core/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...builtinModules, 'react', 'react-dom'].map((name) => ({
            name,
            message: portableImportMessage,
          })),
          patterns: [
            { group: ['node:*', 'react/*', 'react-dom/*'], message: portableImportMessage },
          ],
        },
      ],
    },
  },
  prettier,
);

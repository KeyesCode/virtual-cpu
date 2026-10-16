import { builtinModules } from 'node:module';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const portableImportMessage = 'cpu-core and shared must not depend on Node.js or React APIs.';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '.fredrin/', '.agents/', '.claude/']),
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
    files: ['*.js', '*.ts', 'apps/cli/**/*.ts', 'apps/web/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // cpu-core and shared must run anywhere: no Node built-ins and no React.
    files: ['packages/cpu-core/**/*.ts', 'packages/shared/**/*.ts'],
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

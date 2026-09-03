import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'lib/db/migrations/**',
      'next-env.d.ts',
      '*.config.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // scripts/*.mjs is plain ESM and deliberately outside tsconfig (it has to
        // run in the production image without tsx), but it is still the code that
        // applies migrations — it gets the same type-aware rules as everything else.
        projectService: { allowDefaultProject: ['scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // In financial code an unhandled promise is a silently lost transaction.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'scripts/**/*.mjs'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // Plain ESM run directly by node, so the Node globals are not implied by a
    // TS lib the way they are elsewhere.
    files: ['**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
);

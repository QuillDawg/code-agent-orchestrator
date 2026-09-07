// Flat config (ESLint 10). Type-aware, so the checks that matter here have types to work with.
//
// This is a lint setup restored onto a codebase that grew without one. The rules that are off below are the
// ones that disagree with an established convention rather than finding a defect; each is a candidate to turn
// back on behind its own cleanup pass. What is left on is what catches real problems.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // The fake CLI fixture is a standalone .mjs outside tsconfig; there is nothing for a type-aware rule to read.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Worker output, YAML and CLI JSON all arrive as `unknown` and are narrowed by hand, so unsafe-* and
      // no-base-to-string fire on every parser in the codebase without finding anything.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      // `x!` after an existence check is the house style for indexed access under noUncheckedIndexedAccess.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // Async methods implementing an async interface (RunStore, WorkspaceManager, TaskRunner) legitimately
      // have no await; the signature is the contract.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `let x; ... x = spawn()` where a callback reads x before the assignment cannot become a const.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Initialising before a try/catch that assigns is a deliberate default, not a dead store, and
      // ProcessManager captures `this` once on purpose.
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
  {
    // Hook rules belong to the React files. Elsewhere they only misread `useColor`, which is not a hook.
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);

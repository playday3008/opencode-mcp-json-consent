import js from '@eslint/js';

export default [
  { ignores: ['tests/artifacts/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        AbortController: 'readonly',
        URL: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      curly: 'error',
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      'no-control-regex': 'off',
    },
  },
];

const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  ...expoConfig,
  prettierConfig,
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.expo/**',
      'build/**',
      'ios/**',
      'android/**',
      'eval/**',
      'coverage/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    ignores: ['src/services/purchases.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Network calls (fetch) are forbidden outside src/services/purchases.ts per privacy rules (04_TRD §6).',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'axios',
              message:
                'Network calls (axios) are forbidden outside src/services/purchases.ts per privacy rules (04_TRD §6).',
            },
          ],
        },
      ],
    },
  },
];

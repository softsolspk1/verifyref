// eslint.config.js - lint rules for the server (CommonJS), scripts/tests (.mjs) and the browser app (ES modules)
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'data/', 'public/vendor/', 'desktop/app/', 'desktop/dist/', 'desktop/node_modules/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['public/js/images/worker.js'],
    languageOptions: { globals: { ...globals.worker } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `\-` in a character class is kept on purpose, so a hyphen can never turn into a range
      'no-useless-escape': ['error', { allowRegexCharacters: ['-'] }],
    },
  },
];

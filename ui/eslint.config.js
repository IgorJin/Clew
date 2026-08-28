import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        crypto: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        location: 'readonly',
        sessionStorage: 'readonly',
        WebSocket: 'readonly',
        window: 'readonly',
      },
    },
  },
);

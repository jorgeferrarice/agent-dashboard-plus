import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      // Keep function and component names in the minified build so
      // the error screens' reports name the component that broke.
      output: { keepNames: true },
    },
  },
});

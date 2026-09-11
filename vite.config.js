import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: {
    rollupOptions: {
      input: { main: 'index.html', admin: 'admin.html', student: 'student.html' },
    },
  },
});

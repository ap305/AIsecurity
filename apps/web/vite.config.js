import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: {
        port: 50080,
        host: true,
        proxy: {
            '/api': {
                target: process.env.VITE_API_TARGET || 'http://localhost:4002',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: false,
    },
});

import { createReadStream, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * In development, serve the pipeline's local output (../.data/data) at /data
 * with HTTP Range support, which PMTiles needs. Run the pipeline locally
 * (see README) and leave VITE_DATA_URL unset to use it.
 */
function localData(): Plugin {
  const root = normalize(process.env.LOCAL_DATA_DIR ?? join(import.meta.dirname, '../.data/data'));
  return {
    name: 'local-data',
    configureServer(server) {
      server.middlewares.use('/data', (req, res, next) => {
        const path = normalize(join(root, decodeURIComponent((req.url ?? '/').split('?')[0])));
        if (!path.startsWith(root)) return next();
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          res.setHeader('Content-Length', end - start + 1);
          createReadStream(path, { start, end }).pipe(res);
        } else {
          res.setHeader('Content-Length', size);
          createReadStream(path).pipe(res);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localData()],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: { manualChunks: { maplibre: ['maplibre-gl', 'pmtiles'] } },
    },
  },
});

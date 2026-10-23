import path from 'node:path';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { generateIcons } from './gen-icons.mjs';

const root = process.cwd();
const dist = path.resolve(root, 'dist');
const require = createRequire(import.meta.url);

await generateIcons();
await rm(dist, { recursive: true, force: true });

const common = {
  configFile: false,
  root,
  base: './',
  logLevel: 'warn',
};

const sharedOutput = {
  entryFileNames: 'assets/[name]-[hash].js',
  chunkFileNames: 'assets/[name]-[hash].js',
  assetFileNames: 'assets/[name]-[hash][extname]',
};

console.log('[1/4] 构建设置页 / 弹窗 / 离屏文档…');
await build({
  ...common,
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: dist,
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        options: path.resolve(root, 'options.html'),
        popup: path.resolve(root, 'popup.html'),
        offscreen: path.resolve(root, 'offscreen.html'),
      },
      output: sharedOutput,
    },
  },
});

console.log('[2/4] 构建 Service Worker…');
await build({
  ...common,
  publicDir: false,
  build: {
    outDir: dist,
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: false,
    rollupOptions: {
      input: { background: path.resolve(root, 'src/background/index.ts') },
      output: {
        ...sharedOutput,
        format: 'es',
        inlineDynamicImports: true,
        entryFileNames: 'background.js',
      },
    },
  },
});

console.log('[3/4] 构建内容脚本…');
await build({
  ...common,
  publicDir: false,
  build: {
    outDir: dist,
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: false,
    rollupOptions: {
      input: { content: path.resolve(root, 'src/content/index.ts') },
      output: {
        ...sharedOutput,
        format: 'iife',
        name: 'TransubContent',
        inlineDynamicImports: true,
        entryFileNames: 'content.js',
      },
    },
  },
});

console.log('[4/4] 复制 ONNX Runtime WASM…');
const tfDist = path.dirname(require.resolve('@huggingface/transformers'));
const ortOut = path.join(dist, 'ort');
await mkdir(ortOut, { recursive: true });
let copied = 0;
for (const file of await readdir(tfDist)) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(file)) {
    await copyFile(path.join(tfDist, file), path.join(ortOut, file));
    copied++;
  }
}
if (!copied) throw new Error('未找到 ONNX Runtime WASM 文件，请检查 @huggingface/transformers 安装。');

// Vite 会把 ORT wasm 作为普通资源再打包一份；运行时通过 wasmPaths 指向 dist/ort，删除重复文件。
for (const file of await readdir(path.join(dist, 'assets'))) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(file)) {
    await rm(path.join(dist, 'assets', file));
  }
}

console.log(`\n构建完成：${dist}\n打开 chrome://extensions → 开启开发者模式 → 加载已解压的扩展程序 → 选择 dist/`);

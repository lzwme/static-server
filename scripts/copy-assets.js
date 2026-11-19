#!/usr/bin/env node
/*
 * 构建后静态资源拷贝脚本：将 src 下的静态资源目录拷贝至 dist
 *  - src/localsend：页面源码与图标（index.html、app.js、sw.js、icons 等）
 *  - src/assets：前端构建产物（tailwind 生成的 style.css、vendor 第三方库）
 *
 * 两类内容分开存放：源码目录只放需要人工维护的文件，构建产物集中在 src/assets，
 * 该目录不纳入版本管理，由 npm run build 重新生成。
 *
 * 仅用于开发/构建，不属于 npm 发布内容（package.json 的 files 仅包含 dist 与 ss.config.sample.js）
 */
const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

/** 需要拷贝的静态资源目录（相对 src 的路径） */
const assets = ['localsend', 'assets'];

function copyDir(from, to) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

for (const asset of assets) {
  const from = join(srcDir, asset);
  const to = join(distDir, asset);
  rmSync(to, { recursive: true, force: true });
  copyDir(from, to);
  console.log(`[copy-assets] src/${asset} -> dist/${asset}`);
}

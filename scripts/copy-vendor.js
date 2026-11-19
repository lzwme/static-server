#!/usr/bin/env node
/*
 * 拷贝前端第三方库到 src/assets/localsend/vendor
 * 目的：让 LocalSend 页面完全离线可用（局域网常常没有外网，CDN 会加载失败）
 * 仅用于开发/构建，产物在 src/assets 下，不纳入版本管理
 */
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const vendorDir = join(root, 'src/assets/localsend/vendor');

/** 需要本地化的前端库：源文件 → 目标文件 */
const vendorFiles = [
  {
    from: join(root, 'node_modules/qr-code-styling/lib/qr-code-styling.js'),
    to: join(vendorDir, 'qr-code-styling.js'),
  },
];

if (!existsSync(vendorDir)) mkdirSync(vendorDir, { recursive: true });

for (const file of vendorFiles) {
  if (!existsSync(file.from)) {
    console.warn(`[copy-vendor] 跳过（依赖未安装）：${file.from}`);
    continue;
  }
  copyFileSync(file.from, file.to);
  console.log(`[copy-vendor] ${file.from.replace(root, '.')} -> ${file.to.replace(root, '.')}`);
}

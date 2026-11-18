/**
 * 测试公共辅助
 *
 * 测试直接跑在编译产物（dist）上，避免引入额外的测试框架依赖。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 创建临时目录 */
function tempDir(prefix = 'sserver-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 准备一个临时工作目录并切换过去。
 *
 * 配置加载顺序是「内置默认值 < 用户级配置 < 当前目录配置」，
 * 切到临时目录可以避免读到仓库里或用户机器上的配置。
 */
function useTempConfig(storageDir) {
  const dir = tempDir('sserver-cfg-');
  const config = { port: 0, localsend: { enabled: true, dir: storageDir } };
  fs.writeFileSync(path.join(dir, 'ss.config.js'), `module.exports = ${JSON.stringify(config)};\n`);
  process.chdir(dir);
  return dir;
}

/**
 * 启动一个只挂载 localsend 的服务，返回地址与关闭方法。
 */
async function startServer(storageDir) {
  useTempConfig(storageDir);
  process.env.SS_LOCALSEND_DIR = storageDir;
  const { initLocalsend } = require('../dist/localsend');
  const express = require('express');
  const app = express();
  const handle = await initLocalsend(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      // 先停掉目录监听，否则删除被监听的目录会让进程无法退出
      handle?.stop?.();
      // 长连接（SSE 等）会阻止服务器关闭，这里强制断开
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 用 multipart 方式上传文件 */
async function upload(base, name, content, query = '') {
  const form = new FormData();
  const body = typeof content === 'string' ? content : Buffer.from(content);
  form.append('files', new Blob([body]), name);
  const resp = await fetch(`${base}/localsend/api/upload${query}`, { method: 'POST', body: form });
  return { status: resp.status, json: await resp.json() };
}

/** 请求文件列表，返回完整的分页信息（items / total / page / pageSize / totalPages） */
async function listPage(base, query = '') {
  const resp = await fetch(`${base}/localsend/api/list${query}`);
  return (await resp.json()).data;
}

/** 只取当前页的文件条目 */
async function listFiles(base, query = '') {
  const data = await listPage(base, query);
  return data.items || [];
}

/** 请求筛选选项（目录 / 扩展名） */
async function listFacets(base) {
  const resp = await fetch(`${base}/localsend/api/facets`);
  return (await resp.json()).data;
}

/** 递归删除临时目录 */
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { tempDir, useTempConfig, startServer, upload, listFiles, listPage, listFacets, removeDir };

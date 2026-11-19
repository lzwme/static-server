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
 * 测试期间的用户主目录（隔离用）。
 *
 * 配置加载顺序是「内置默认值 < 用户级配置 < 当前目录配置」，
 * 其中用户级配置来自 ~/.static-server。若不隔离，测试会读到开发者机器上的
 * 真实配置（口令、令牌等），导致用例结果不可预期；
 * 运行时设置文件同样会写进真实目录。
 * 因此这里把用户主目录指向临时目录，两者一并隔离。
 */
let testHomeDir = null;

/** 隔离用户级配置与运行时设置目录 */
function isolateUserHome() {
  if (!testHomeDir) {
    testHomeDir = tempDir('sserver-home-');
    process.env.USERPROFILE = testHomeDir;
    process.env.HOME = testHomeDir;
  }
  // 运行时设置文件默认写在用户配置目录下，也要隔离；
  // 若用例显式指定了路径（如设置接口测试），则尊重用例的指定
  if (!process.env.SS_LOCALSEND_SETTINGS) {
    process.env.SS_LOCALSEND_SETTINGS = path.join(testHomeDir, 'localsend-settings.json');
  }
  return testHomeDir;
}

/**
 * 准备一个临时工作目录并切换过去。
 *
 * 配置加载顺序是「内置默认值 < 用户级配置 < 当前目录配置」，
 * 切到临时目录可以避免读到仓库里或用户机器上的配置。
 *
 * extra 用于追加 localsend 下的配置项（如 password、token）。
 */
function useTempConfig(storageDir, extra) {
  isolateUserHome();
  const dir = tempDir('sserver-cfg-');
  const localsend = { enabled: true, dir: storageDir, ...(extra || {}) };
  const config = { port: 0, localsend };
  fs.writeFileSync(path.join(dir, 'ss.config.js'), `module.exports = ${JSON.stringify(config)};\n`);
  process.chdir(dir);
  return dir;
}

/**
 * 启动一个只挂载 localsend 的服务，返回地址与关闭方法。
 *
 * 配置模块内部有缓存（ssConfig 单例），同一进程内多次启动服务会复用第一次的配置，
 * 因此这里先清掉 config / localsend 的模块缓存，让每个服务都读到自己的配置。
 */
async function startServer(storageDir, extra) {
  useTempConfig(storageDir, extra);
  process.env.SS_LOCALSEND_DIR = storageDir;
  for (const mod of ['../dist/config', '../dist/lib/localsend']) {
    delete require.cache[require.resolve(mod)];
  }
  const { initLocalsend } = require('../dist/lib/localsend');
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

/** 用 multipart 方式上传文件，可带查询串与请求头（如会话令牌） */
async function upload(base, name, content, query = '', headers = {}) {
  const form = new FormData();
  const body = typeof content === 'string' ? content : Buffer.from(content);
  form.append('files', new Blob([body]), name);
  const resp = await fetch(`${base}/localsend/api/upload${query}`, { method: 'POST', body: form, headers });
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

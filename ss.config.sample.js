/** @type {import('@lzwme/sserver').SSConfig} */
module.exports = {
  // port: 8888,
  https: false,
  sslCache: '',
  rootDir: '.',
  // localsend 局域网文件传输。可设为 true 开启，或传入对象配置
  // localsend: {
  //   enabled: true,
  //   // 文件存储目录。默认 ~/.static-server/localsend，可用环境变量 SS_LOCALSEND_DIR 覆盖
  //   dir: '~/localsend',
  //   // 单个文件上传大小限制（字节），默认 1GB
  //   maxSize: 1024 * 1024 * 1024,
  // },
  proxyConfig: [
    // 内网代理企业微信机器人接口示例
    {
      api: '/proxy/cgi-bin/webhook/send',
      config: {
        target: 'https://qyapi.weixin.qq.com',
        changeOrigin: true,
        pathRewrite: {
          '^/proxy/cgi-bin': '/cgi-bin',
        },
      },
    },
  ],
};

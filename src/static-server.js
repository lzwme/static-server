/* eslint-disable no-console */
/*
 * @Author: lzw
 * @Date: 2021-05-28 16:24:40
 * @LastEditors: lzw
 * @LastEditTime: 2021-06-03 22:50:35
 * @Description:
 */

const express = require('express');
const path = require('path');
const { exec } = require('child_process');

const optionDefault = {
    port: 6010,
    dir: '.',
    open: true,
};

const initServer = (options = optionDefault) => {
    options = Object.assign({}, optionDefault, options);

    const staticRoot = options.dir || path.resolve(__dirname, '../dist');
    const port = +options.port || 6010;
    const app = express();

    // @see https://www.expressjs.com.cn/4x/api.html#express.static
    app.use(express.static(staticRoot));

    // app.get('/', function (req, res) {
    //     res.send('Hello World');
    // });

    app.listen(port, () => {
        console.log(`Static serve Listening Port:`, port);
        console.log(`Static DIR:`, staticRoot);
    });

    if (options.open !== false) {
        const openPageCmd = (process.platform === 'win32' ? `start` : `open`) + ` http://localhost:${port}`;
        exec(openPageCmd);
    }
}
exports.initServer = initServer;

// initServer();

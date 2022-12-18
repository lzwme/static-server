import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { createCA, createCert } from './mkcert';
import { resolve } from 'path';
import { logger } from '../get-logger';
import { greenBright } from 'console-log-colors';

export async function getCert(host = 'localhost', cacheDir = '') {
  const result = {
    caKey: '',
    caCrt: '',
    certKey: '',
    certCrt: '',
  };
  const dirs = {
    caKey: resolve(cacheDir, 'ca.key'),
    caCrt: resolve(cacheDir, 'ca.crt'),
    certKey: resolve(cacheDir, `${host}.key`),
    certCrt: resolve(cacheDir, `${host}.crt`),
  };

  if (cacheDir) {
    if (!existsSync(cacheDir)) mkdir(cacheDir, { recursive: true });
    for (const [key, filepath] of Object.entries(dirs)) {
      if (existsSync(filepath)) result[key as keyof typeof result] = await readFile(filepath, 'utf8');
    }
  }

  if (!result.caKey) {
    const attributes = [
      { name: 'commonName', value: 'sserver' },
      { name: 'countryName', value: 'CN' },
      { name: 'stateOrProvinceName', value: 'gd' },
      { name: 'localityName', value: 'gz' },
      { name: 'organizationName', value: 'lzw.me' },
      { name: 'organizationalUnitName', value: 'lzw.me' },
      // { name: 'emailAddress', value: `webmaster@${host}` },
    ];
    // create a certificate authority
    const ca = await createCA({
      subject: attributes,
      issuer: attributes,
    });
    result.caKey = ca.key;
    result.caCrt = ca.cert;

    if (cacheDir) {
      await writeFile(dirs.caKey, result.caKey, 'utf8');
      await writeFile(dirs.caCrt, result.caCrt, 'utf8');
      logger.info('save SSL CA certificate privateKey:', greenBright(dirs.caKey));
      logger.info('save SSL CA certificate publicKey:', greenBright(dirs.caCrt));
    }
  }

  if (!result.certKey) {
    const cert = await createCert({
      domains: [host, '127.0.0.1'],
      caKey: result.caKey,
      caCert: result.caCrt,
      subject: [
        { name: 'countryName', value: 'CN' },
        { name: 'stateOrProvinceName', value: 'gd' },
        { name: 'localityName', value: 'gz' },
        { name: 'organizationName', value: 'sserver' },
        { name: 'organizationalUnitName', value: 'sserver' },
      ],
    });
    result.certKey = cert.key;
    result.certCrt = cert.cert;

    if (cacheDir) {
      await writeFile(dirs.certKey, result.certKey, 'utf8');
      await writeFile(dirs.certCrt, result.certCrt, 'utf8');
      logger.info('save SSL server certificate privateKey:', greenBright(dirs.certKey));
      logger.info('save SSL server certificate publicKey:', greenBright(dirs.certCrt));
    }
  }

  return result;
}

import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { createCA, createCert } from 'mkcert';
import { resolve } from 'path';

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
    certKey: resolve(cacheDir, 'cert.key'),
    certCrt: resolve(cacheDir, 'cert.crt'),
  };

  if (cacheDir) {
    for (const [key, filepath] of Object.entries(dirs)) {
      if (existsSync(filepath)) result[key as keyof typeof result] = await readFile(filepath, 'utf8');
    }
  }

  if (!result.caKey) {
    // create a certificate authority
    const ca = await createCA({
      organization: 'lzwme',
      countryCode: 'zh-CN',
      state: 'gd',
      locality: 'gz',
      validityDays: 3650,
    });
    result.caKey = ca.key;
    result.caCrt = ca.cert;

    if (cacheDir) {
      await writeFile(dirs.caKey, result.caKey, 'utf8');
      await writeFile(dirs.caCrt, result.caCrt, 'utf8');
    }
  }

  if (!result.certKey) {
    const cert = await createCert({
      domains: [host, '127.0.0.1'],
      validityDays: 3650,
      caKey: result.caKey,
      caCert: result.caCrt,
    });
    result.certKey = cert.key;
    result.certCrt = cert.cert;

    if (cacheDir) {
      await writeFile(dirs.certKey, result.certKey, 'utf8');
      await writeFile(dirs.certCrt, result.certCrt, 'utf8');
    }
  }

  return result;
}

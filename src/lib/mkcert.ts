// @see https://github.com/Subash/mkcert

import { pki, md } from 'node-forge';
import { promisify } from 'util';
const generateKeyPair = promisify(pki.rsa.generateKeyPair.bind(pki.rsa));

interface GenCertOptions {
  subject: pki.CertificateField[];
  issuer: pki.CertificateField[];
  extensions?: any[];
  validityDays?: number;
  signWith?: string;
}

export async function generateCert(options: GenCertOptions) {
  let { subject, issuer, extensions = [], validityDays = 36500, signWith } = options;
  // create serial from and integer between 50000 and 99999
  const serial = Math.floor(Math.random() * 95000 + 50000).toString();
  const keyPair = await generateKeyPair({ bits: 2048, workers: 4 });
  const cert = pki.createCertificate();

  cert.publicKey = keyPair.publicKey;
  cert.serialNumber = Buffer.from(serial).toString('hex'); // serial number must be hex encoded
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notAfter.getDate() + validityDays);

  // certificate Attributes: https://git.io/fptna
  cert.setSubject(subject);
  cert.setIssuer(issuer);
  cert.setExtensions(extensions);

  // sign the certificate with it's own private key if no separate signing key is provided
  const signKey = signWith ? pki.privateKeyFromPem(signWith) : keyPair.privateKey;
  cert.sign(signKey, md.sha256.create());

  return {
    key: pki.privateKeyToPem(keyPair.privateKey),
    cert: pki.certificateToPem(cert),
  };
}

export function createCA(options: GenCertOptions) {
  if (!options.extensions) options.extensions = [];
  // required certificate extensions for a certificate authority
  options.extensions = [
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, critical: true },
    ...options.extensions,
  ];

  return generateCert(options);
}

interface CreateCert extends Omit<Partial<GenCertOptions>, 'issuer'> {
  domains: string[];
  caKey: string;
  caCert: string;
}

export function createCert(options: CreateCert) {
  // certificate Attributes: https://git.io/fptna
  if (!options.subject) options.subject = [];
  if (!options.subject.find(d => d.name === 'commonName')) {
      // use the first address as common name
      options.subject.push({ name: 'commonName', value: options.domains[0] });
  }

  // required certificate extensions for a tls certificate
  const extensions = [
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    {
      name: 'subjectAltName',
      altNames: options.domains.map(domain => {
        const types = { domain: 2, ip: 7 }; // available Types: https://git.io/fptng
        const isIp = isIP(domain);

        if (isIp) return { type: types.ip, ip: domain };
        return { type: types.domain, value: domain };
      }),
    },
    ...(options.extensions || []),
  ];

  const ca = pki.certificateFromPem(options.caCert);

  return generateCert({
    ...options,
    subject: options.subject,
    issuer: ca.subject.attributes,
    extensions,
    signWith: options.caKey,
  });
}

function isIP(ip: string) {
  if (!ip) return false;
  if (/::/.test(ip)) return true; // ipv6
  const v4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
  return v4.test(ip);
}

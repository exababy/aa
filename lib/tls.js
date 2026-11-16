'use strict';
/**
 * Yerel ağ için HTTPS: PWA'nın telefona "Yükle" ile kurulabilmesi için güvenli bağlantı gerekir.
 * İlk açılışta DATA_DIR/tls altında bir yerel kök sertifika (CA) ve sunucu sertifikası üretilir.
 * Kök sertifika her telefona bir kez kurulur (bkz. /kurulum); sonrasında Chrome bağlantıyı güvenli sayar.
 * Sunucunun IP adresi değişirse yalnızca sunucu sertifikası yenilenir, telefonlara yeniden kurulum gerekmez.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const forge = require('node-forge');

const { pki } = forge;
const DAY = 86400000;

function keyPair() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const key = pki.privateKeyFromPem(pem);
  return { key, pub: pki.setRsaPublicKey(key.n, key.e), pem };
}
const serial = () => `00${crypto.randomBytes(15).toString('hex')}`;

function makeCa() {
  const { key, pub, pem } = keyPair();
  const cert = pki.createCertificate();
  cert.publicKey = pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 3650 * DAY);
  const name = [{ name: 'commonName', value: 'SAS Smart Yerel Sertifika' }, { name: 'organizationName', value: 'SAS Smart PWA' }];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(key, forge.md.sha256.create());
  return { keyPem: pem, certPem: pki.certificateToPem(cert) };
}

function makeServer(ca, hosts) {
  const caKey = pki.privateKeyFromPem(ca.keyPem);
  const caCert = pki.certificateFromPem(ca.certPem);
  const { pub, pem } = keyPair();
  const cert = pki.createCertificate();
  cert.publicKey = pub;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 397 * DAY);
  cert.setSubject([{ name: 'commonName', value: hosts[0] }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: hosts.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? { type: 7, ip: h } : { type: 2, value: h })) },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { keyPem: pem, certPem: pki.certificateToPem(cert) };
}

function localHosts(extra = '') {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  return [...new Set([...ips, ...String(extra).split(',').map((v) => v.trim()).filter(Boolean), 'localhost', '127.0.0.1'])];
}

/** Sertifikaları yükler; yoksa, süresi dolmak üzereyse ya da adres listesi değiştiyse üretir. */
function load(dir, extraHosts) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  const read = (n) => { try { return fs.readFileSync(f(n), 'utf8'); } catch { return ''; } };
  let ca = { keyPem: read('ca.key'), certPem: read('ca.crt') };
  if (!ca.keyPem || !ca.certPem) {
    ca = makeCa();
    fs.writeFileSync(f('ca.key'), ca.keyPem, { mode: 0o600 });
    fs.writeFileSync(f('ca.crt'), ca.certPem);
    fs.rmSync(f('server.crt'), { force: true });
  }
  const hosts = localHosts(extraHosts);
  let srv = { keyPem: read('server.key'), certPem: read('server.crt') };
  let fresh = false;
  try {
    const cert = new crypto.X509Certificate(srv.certPem);
    const covered = hosts.every((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? cert.checkIP(h) : cert.checkHost(h)));
    fresh = !!srv.keyPem && covered && Date.parse(cert.validTo) - Date.now() > 30 * DAY;
  } catch { /* yok ya da bozuk */ }
  if (!fresh) {
    srv = makeServer(ca, hosts);
    fs.writeFileSync(f('server.key'), srv.keyPem, { mode: 0o600 });
    fs.writeFileSync(f('server.crt'), srv.certPem);
  }
  return { key: srv.keyPem, cert: srv.certPem, ca: ca.certPem, hosts };
}

module.exports = { load, localHosts };

import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

export type ProxyCertificate = { key: string; cert: string };

// The key lives as long as the runner process, which can run for years.
const validDays = 3650;

type ExtensionOptions = { isCritical?: boolean };

const lengthOf = (size: number) => {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
};

const sequence = (...parts: Buffer[]) => der(0x30, ...parts);

const oid = (text: string) => {
  const [first = 0, second = 0, ...rest] = text.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const value of rest) {
    const groups = [value & 0x7f];
    for (let left = value >> 7; left > 0; left >>= 7) groups.unshift((left & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};

// The first byte is 0x40 to 0x7f, so the DER integer is positive and minimal.
const serialNumber = () => {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x3f) | 0x40;
  return der(0x02, bytes);
};

const utcTime = (date: Date) =>
  der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));

const extension = (id: string, value: Buffer, { isCritical = false }: ExtensionOptions = {}) =>
  sequence(oid(id), ...(isCritical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));

// Own DER code: node:crypto cannot make X.509.
export const createProxyCertificate = (name: string): ProxyCertificate => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signatureAlgorithm = sequence(oid("1.2.840.10045.4.3.2"));
  const subject = sequence(der(0x31, sequence(oid("2.5.4.3"), der(0x0c, Buffer.from(name)))));
  const now = Date.now();
  const extensions = der(
    0xa3,
    sequence(
      extension("2.5.29.17", sequence(der(0x82, Buffer.from(name)))),
      extension("2.5.29.19", sequence(), { isCritical: true }),
      extension("2.5.29.37", sequence(oid("1.3.6.1.5.5.7.3.1"))),
    ),
  );
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    serialNumber(),
    signatureAlgorithm,
    subject,
    sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + validDays * 86_400_000))),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", toBeSigned, { key: privateKey, dsaEncoding: "der" });
  const certificate = sequence(
    toBeSigned,
    signatureAlgorithm,
    der(0x03, Buffer.from([0]), signature),
  );
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: new X509Certificate(certificate).toString(),
  };
};

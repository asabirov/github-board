import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface CredentialKeyProvider { key(): Buffer }
export class EnvironmentCredentialKey implements CredentialKeyProvider {
  constructor(private readonly encoded: string) {}
  key(): Buffer {
    const key = Buffer.from(this.encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== this.encoded) throw new Error('BOARD_CREDENTIAL_KEY must encode 32 bytes');
    return key;
  }
}
export class CredentialCipher {
  constructor(private readonly provider: CredentialKeyProvider) {}
  encrypt(secret: string, binding: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.provider.key(), iv);
    cipher.setAAD(Buffer.from(binding));
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  decrypt(encoded: string, binding: string): string {
    const data = Buffer.from(encoded, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.provider.key(), data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    cipher.setAAD(Buffer.from(binding));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  }
}

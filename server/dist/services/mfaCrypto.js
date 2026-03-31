"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptMfaSecret = encryptMfaSecret;
exports.decryptMfaSecret = decryptMfaSecret;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
function getKey() {
    return crypto_1.default.createHash('sha256').update(`${config_1.JWT_SECRET}:mfa:v1`).digest();
}
/** Encrypt TOTP secret for storage in SQLite. */
function encryptMfaSecret(plain) {
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv('aes-256-gcm', getKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptMfaSecret(blob) {
    const buf = Buffer.from(blob, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
//# sourceMappingURL=mfaCrypto.js.map
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JWT_SECRET = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
let JWT_SECRET = process.env.JWT_SECRET || '';
exports.JWT_SECRET = JWT_SECRET;
if (!JWT_SECRET) {
    const dataDir = path_1.default.resolve(__dirname, '../data');
    const secretFile = path_1.default.join(dataDir, '.jwt_secret');
    try {
        exports.JWT_SECRET = JWT_SECRET = fs_1.default.readFileSync(secretFile, 'utf8').trim();
    }
    catch {
        exports.JWT_SECRET = JWT_SECRET = crypto_1.default.randomBytes(32).toString('hex');
        try {
            if (!fs_1.default.existsSync(dataDir))
                fs_1.default.mkdirSync(dataDir, { recursive: true });
            fs_1.default.writeFileSync(secretFile, JWT_SECRET, { mode: 0o600 });
            console.log('Generated and saved JWT secret to', secretFile);
        }
        catch (writeErr) {
            console.warn('WARNING: Could not persist JWT secret to disk:', writeErr instanceof Error ? writeErr.message : writeErr);
            console.warn('Sessions will reset on server restart. Set JWT_SECRET env var for persistent sessions.');
        }
    }
}
//# sourceMappingURL=config.js.map
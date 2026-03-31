"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maxLength = maxLength;
exports.validateStringLengths = validateStringLengths;
function maxLength(field, max) {
    return (req, res, next) => {
        if (req.body[field] && typeof req.body[field] === 'string' && req.body[field].length > max) {
            res.status(400).json({ error: `${field} must be ${max} characters or less` });
            return;
        }
        next();
    };
}
function validateStringLengths(maxLengths) {
    return (req, res, next) => {
        for (const [field, max] of Object.entries(maxLengths)) {
            const value = req.body[field];
            if (value && typeof value === 'string' && value.length > max) {
                res.status(400).json({ error: `${field} must be ${max} characters or less` });
                return;
            }
        }
        next();
    };
}
//# sourceMappingURL=validate.js.map
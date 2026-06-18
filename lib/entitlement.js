const crypto = require('crypto');

function toBase64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signToken(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(unsigned)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${unsigned}.${signature}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'token missing' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'token format invalid' };
  }
  const [encodedHeader, encodedPayload, signature] = parts;
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(unsigned)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  if (expected !== signature) {
    return { valid: false, reason: 'token signature invalid' };
  }
  try {
    const header = JSON.parse(fromBase64Url(encodedHeader));
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      return { valid: false, reason: 'token header invalid' };
    }
    if (!payload.exp || Date.now() >= Number(payload.exp) * 1000) {
      return { valid: false, reason: 'token expired' };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'token parse failed' };
  }
}

module.exports = { signToken, verifyToken };

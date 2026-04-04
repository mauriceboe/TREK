/// <reference types="node" />
import { getAuthConfigProvider } from '@convex-dev/better-auth/auth-config';
import type { AuthConfig } from 'convex/server';

export default {
  providers: [
    getAuthConfigProvider(),
    {
      type: 'customJwt',
      issuer: process.env.CONVEX_AUTH_ISSUER_URL || 'http://localhost:3001/api/auth/convex',
      jwks: process.env.CONVEX_JWKS_URI || 'data:text/plain;charset=utf-8,%7B%22keys%22%3A%5B%5D%7D',
      algorithm: 'RS256',
      applicationID: process.env.CONVEX_APPLICATION_ID || 'trek-web',
    },
  ],
} satisfies AuthConfig;

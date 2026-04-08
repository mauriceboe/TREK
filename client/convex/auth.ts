/// <reference types="node" />
import { createClient, type GenericCtx } from '@convex-dev/better-auth';
import { convex, crossDomain } from '@convex-dev/better-auth/plugins';
import { username } from 'better-auth/plugins';
import { betterAuth } from 'better-auth/minimal';
import { components } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import authConfig from './auth.config';

const siteUrl = (process.env.SITE_URL || 'http://localhost:5173').replace(/\/$/, '');
const trustedOrigins = [
  siteUrl,
  ...(process.env.TRUSTED_ORIGINS || '')
    .split(',')
    .map((value: string) => value.trim())
    .filter(Boolean),
];

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.CONVEX_SITE_URL,
    trustedOrigins,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      requireEmailVerification: false,
      disableSignUp: process.env.INVITE_ONLY === 'true',
    },
    user: {
      deleteUser: {
        enabled: true,
      },
    },
    plugins: [
      username(),
      crossDomain({ siteUrl }),
      convex({ authConfig }),
    ],
  });

// Export getAuthUser for use with ConvexBetterAuthProvider / AuthBoundary
export const { getAuthUser } = authComponent.clientApi();

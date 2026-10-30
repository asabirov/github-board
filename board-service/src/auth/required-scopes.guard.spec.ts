import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequiredScopesGuard } from './required-scopes.guard';
import { REQUIRED_SCOPES } from './required-scopes.decorator';
import { BOARD_READ, BOARD_ADMIN } from './scopes';

function ctx(user: unknown, required?: string[], method = 'GET'): ExecutionContext {
  const reflector = new Reflector();
  const handler = () => undefined;
  if (required !== undefined) Reflect.defineMetadata(REQUIRED_SCOPES, required, handler);
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, method }) }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

const guard = () => new RequiredScopesGuard(new Reflector());

describe('RequiredScopesGuard (#56)', () => {
  it('passes a human (no scopes) on any route', () => {
    expect(guard().canActivate(ctx({ sub: 'h', email: 'a@example.com' }))).toBe(true);
  });
  it('passes a public request (no user)', () => {
    expect(guard().canActivate(ctx(undefined))).toBe(true);
  });
  it('a scoped actor needs board:read by default (undecorated route)', () => {
    expect(guard().canActivate(ctx({ scopes: [BOARD_READ] }))).toBe(true);
    expect(() => guard().canActivate(ctx({ scopes: [BOARD_ADMIN] }))).toThrow(ForbiddenException);
  });
  it('an explicit @RequiredScopes replaces the default', () => {
    // exactly admin can pass an admin route but not a read route
    expect(guard().canActivate(ctx({ scopes: [BOARD_ADMIN] }, [BOARD_ADMIN]))).toBe(true);
    expect(() => guard().canActivate(ctx({ scopes: [BOARD_ADMIN] }, [BOARD_READ]))).toThrow(ForbiddenException);
  });
  it('admin route requires board:admin', () => {
    expect(() => guard().canActivate(ctx({ scopes: [BOARD_READ] }, [BOARD_ADMIN]))).toThrow(ForbiddenException);
    expect(guard().canActivate(ctx({ scopes: [BOARD_READ, BOARD_ADMIN] }, [BOARD_ADMIN]))).toBe(true);
  });
  it('empty @RequiredScopes() means no requirement for a scoped actor', () => {
    expect(guard().canActivate(ctx({ scopes: [] }, []))).toBe(true);
  });

  // Regression coverage: static agent tokens carry [board:read]. Before this
  // fix, RequiredScopesGuard's undecorated-route default was always board:read
  // regardless of method, so an agent could reach any undecorated WRITE route
  // (PATCH/POST/DELETE) it should have been 403'd on.
  it('denies a scoped actor on an undecorated write route (fail-closed default)', () => {
    expect(() =>
      guard().canActivate(ctx({ scopes: [BOARD_READ] }, undefined, 'POST')),
    ).toThrow(ForbiddenException);
  });
  it('passes a scoped actor on an undecorated GET route (read default unchanged)', () => {
    expect(guard().canActivate(ctx({ scopes: [BOARD_READ] }, undefined, 'GET'))).toBe(true);
  });
  it('an explicit @RequiredScopes on a POST route overrides the write-deny default', () => {
    expect(
      guard().canActivate(ctx({ scopes: [BOARD_ADMIN] }, [BOARD_ADMIN], 'POST')),
    ).toBe(true);
  });

  describe('static agent token regression (#56)', () => {
    const agentScopes = [BOARD_READ];

    it('is denied on an undecorated write route (e.g. PATCH /okr/kr/:taskId)', () => {
      expect(() =>
        guard().canActivate(ctx({ scopes: agentScopes }, undefined, 'PATCH')),
      ).toThrow(ForbiddenException);
    });
    it('is allowed on /mcp (@RequiredScopes(BOARD_READ), method POST)', () => {
      expect(
        guard().canActivate(ctx({ scopes: agentScopes }, [BOARD_READ], 'POST')),
      ).toBe(true);
    });
  });
});

import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SCOPES = 'requiredScopes';

/**
 * Declare the board:* scopes a route requires of a scoped (programmatic) actor.
 * No args = an explicit "no scope requirement" (bypasses the guard's default
 * board:read). Humans (no req.user.scopes) are never gated by this.
 */
export const RequiredScopes = (...scopes: string[]) => SetMetadata(REQUIRED_SCOPES, scopes);

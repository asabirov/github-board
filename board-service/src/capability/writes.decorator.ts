import { SetMetadata } from '@nestjs/common';
import type { Capability } from './capability';

export const WRITES_CAPABILITY = 'writesCapability';

/**
 * Declare the Github capabilities this route needs of the BOARD'S credential.
 * No args = an explicit "this route writes no Github" — a real answer, and the
 * one nine of this board's twenty write routes give. ABSENT metadata is not that
 * answer, and the guard denies it.
 */
export const Writes = (...caps: Capability[]) => SetMetadata(WRITES_CAPABILITY, caps);

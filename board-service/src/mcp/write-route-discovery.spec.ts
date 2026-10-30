import { describe, it, expect } from 'vitest';
import { extractWriteRoutes } from './write-route-discovery.contract';

/**
 * The fixture tests for the source-level route discovery. They moved here with
 * the functions they test when `write-route-discovery.contract.ts` was split out
 * of `mcp-rest-parity.spec.ts` (#584), so the discovery and its fixtures still
 * sit beside each other and neither gate owns the other's suite.
 */
describe('write-route discovery handles real controller shapes', () => {
  it('reads a bare-string base + simple path', () => {
    const src = `@Controller('okr') class C { @Post('refresh') r() {} }`;
    expect(extractWriteRoutes(src)).toEqual(['POST okr/refresh']);
  });

  it('reads an empty path (base only)', () => {
    expect(extractWriteRoutes(`@Controller('aor') class C { @Post() c() {} }`)).toEqual(['POST aor']);
  });

  it('reads a multiline decorator with a trailing comma', () => {
    const src = `@Controller('okr') class C {\n  @Patch(\n    'kr/:id',\n  )\n  u() {}\n}`;
    expect(extractWriteRoutes(src)).toEqual(['PATCH okr/kr/:id']);
  });

  it('reads the first path even with a second decorator argument', () => {
    const src = `@Controller('x') class C { @Post('y', SomeInterceptor) f() {} }`;
    expect(extractWriteRoutes(src)).toEqual(['POST x/y']);
  });

  it('expands an array of paths into one route each', () => {
    const src = `@Controller('x') class C { @Delete(['a', 'b/:id']) d() {} }`;
    expect(extractWriteRoutes(src)).toEqual(['DELETE x/a', 'DELETE x/b/:id']);
  });

  it('reads a template-literal path', () => {
    expect(extractWriteRoutes('@Controller() class C { @Put(`ident`) p() {} }')).toEqual([
      'PUT ident',
    ]);
  });

  it('normalizes leading / double slashes', () => {
    const src = `@Controller('okr') class C { @Post('/refresh') r() {} }`;
    expect(extractWriteRoutes(src)).toEqual(['POST okr/refresh']);
  });

  it('reads a @Controller options object base', () => {
    const src = `@Controller({ path: 'okr' }) class C { @Post('refresh') r() {} }`;
    expect(extractWriteRoutes(src)).toEqual(['POST okr/refresh']);
  });

  it('fails LOUD (not silent) on a path it cannot read statically', () => {
    const src = `@Controller('x') class C { @Post(ROUTE_CONST) f() {} }`;
    expect(extractWriteRoutes(src)).toEqual(['POST <unparsed:ROUTE_CONST>']);
  });

  it('ignores read decorators', () => {
    expect(extractWriteRoutes(`@Controller('x') class C { @Get('y') g() {} }`)).toEqual([]);
  });
});

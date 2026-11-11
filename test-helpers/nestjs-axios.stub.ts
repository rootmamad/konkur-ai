/**
 * Jest CJS stub for the ESM-only @nestjs/axios package (v12 ships only
 * `"type": "module"` output, which ts-jest/jest in CJS mode cannot parse).
 * Wired via `moduleNameMapper` in package.json so every suite that
 * transitively imports ai.service gets this stub; unit tests never perform
 * real HTTP. Suites that declare their own `jest.mock('@nestjs/axios',
 * ...)` factory keep taking precedence over this mapping.
 */

export class HttpService {
  // Shape-mirror only: no method is ever called in unit tests.
  get(): never {
    throw new Error('HttpService stub: no HTTP in unit tests');
  }
  post(): never {
    throw new Error('HttpService stub: no HTTP in unit tests');
  }
}

export class HttpModule {
  static forRoot(): {
    module: typeof HttpModule;
    providers: never[];
    exports: (typeof HttpModule)[];
  } {
    return { module: HttpModule, providers: [], exports: [HttpModule] };
  }
}

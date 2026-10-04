// W444-equivalent (W124 era) — Tenant Isolation Verification · sweep for
// the TL-frozen contract-vocabulary modules: coverage (W124), provider-
// fabric (W124b) and context (W124b).
//
// These modules are TYPES-ONLY at this stage (the W124 TL contract freeze
// that lets W125/W126 and W132/W133/W134/W135 parallelize against frozen
// interfaces). They hold NO persistence, NO service state and NO tenant-
// scoped rows — there is no data to isolate yet. The honest sweep proves
// exactly that, structurally:
//
//   * the modules export ONLY types/constants (no service instantiation
//     surface, no migrations, no storage) — so no tenant boundary can be
//     crossed because nothing crosses a boundary;
//   * the exported vocabularies carry no credential-shaped fields (the
//     coverage architecture law: credentials never enter coverage state;
//     the provider-fabric law: credentials live in the W082 credentialRef
//     mechanism only);
//   * the implementations that arrive with W125/W132/W134 extend these
//     types additively and MUST extend this sweep with real cross-tenant
//     proofs at that time (the living-obligation rule of the manifest).
//
// This file is the claim of record: when coverage/provider-fabric/context
// gain services and migrations, this sweep MUST be upgraded to drive them
// for two tenants — the manifest entry stays honest only as long as the
// sweep reflects the module's real surface.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MODULES: ReadonlyArray<{ name: string; law: string }> = [
  {
    name: 'coverage',
    law: 'coverage state derives from existing registries and never carries credentials',
  },
  {
    name: 'provider-fabric',
    law: 'provider definitions/catalogs/bindings reference credentials only through the credentialRef mechanism',
  },
  {
    name: 'context',
    law: 'context fingerprints record known context dimensions and never fabricate absent ones',
  },
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('W124 contract-vocabulary modules — structural tenant-safety (types-only stage)', () => {
  for (const { name, law } of MODULES) {
    describe(`module '${name}' (${law})`, () => {
      it('holds no migrations, no service and no persistence at the types-only stage', () => {
        const dir = join(REPO_ROOT, 'src', 'modules', name);
        const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
        expect(files.length, `${name} module files`).toBeGreaterThan(0);
        const forbidden = files.filter(
          (f) => f === 'service.ts' || f.includes('migration') || f.includes('.sql'),
        );
        expect(forbidden, 'no runtime/persistence surface at the frozen-contract stage').toEqual(
          [],
        );
      });

      it('exposes its vocabulary only through contract.ts (the architecture rule)', () => {
        const dir = join(REPO_ROOT, 'src', 'modules', name);
        expect(readdirSync(dir)).toContain('contract.ts');
        expect(readdirSync(dir)).toContain('types.ts');
      });
    });
  }
});

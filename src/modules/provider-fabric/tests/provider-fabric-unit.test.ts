// Unit tests for the provider-fabric module's pure logic (no database, no
// transport, no clock): vocabulary guards, the code-owned wire-protocol
// map, credential-substring detection and the input validators.
//
// The FIVE prior-execution failure lessons are regression-locked HERE:
//   1. ALLOWED-KEYS-FIRST — unknown input keys are rejected BEFORE any
//      credential-value scan, so allowed field names (contextWindowTokens,
//      maxOutputTokens, price*) are never conflated with payloads;
//   2. SAMPLE-INPUT STRIPPING — the model-sample validator rejects
//      reference/system-minted keys (definitionId, entryId, origin,
//      discoveredAt, status, tenantId);
//   3. UNANCHORED credential detection — tokens embedded in URL
//      hosts/userinfo and prose are caught, not only bare anchored ones;
//   (4) never double-registering a provider slug in one tenant and
//   (5) the uniform definition_not_found are storage-behavior lessons —
//   they are locked in the service test file.)

import { describe, expect, it } from 'vitest';
import { LLM_PROVIDERS } from '@/modules/llm/contract';
import { ProviderFabricError } from '../errors';
import type {
  ConnectKnownProviderInput,
  RegisterCustomProviderInput,
  RegisterModelManuallyInput,
  UpdateProviderDefinitionInput,
} from '../types';
import {
  MODEL_SAMPLE_KEYS,
  PROVIDER_WIRE_PROTOCOLS,
  containsCredentialLikeToken,
  isModelBindingPurpose,
  isModelCatalogCapability,
  isProviderDefinitionKind,
  isUuid,
  isWireProtocolKind,
  knownProviderWireProtocol,
  sanitizeTransportDetail,
  sanitizeUserNote,
  validateAttachModelBindingInput,
  validateConnectKnownProviderInput,
  validateDiscoveryReceipt,
  validateListModelBindingsQuery,
  validateListModelCatalogQuery,
  validateListProviderDefinitionsQuery,
  validateModelSample,
  validateRecordProviderHealthInput,
  validateRegisterCustomProviderInput,
  validateRegisterModelInput,
  validateUpdateProviderDefinitionInput,
} from '../validation';

function expectCode(code: ProviderFabricError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected ProviderFabricError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderFabricError);
    expect((error as ProviderFabricError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

describe('provider-fabric vocabularies', () => {
  it('guards the wire protocol vocabulary', () => {
    for (const protocol of PROVIDER_WIRE_PROTOCOLS_OPENAI_FAMILY()) {
      expect(isWireProtocolKind(protocol)).toBe(true);
    }
    expect(isWireProtocolKind('smtp')).toBe(false);
    expect(isWireProtocolKind('openai-compatible-v2')).toBe(false);
    expect(isWireProtocolKind(42)).toBe(false);
  });

  it('guards the binding purpose vocabulary (mirrors the W034 LlmScope)', () => {
    expect(isModelBindingPurpose('cognition')).toBe(true);
    expect(isModelBindingPurpose('conversation')).toBe(true);
    expect(isModelBindingPurpose('analysis')).toBe(true);
    expect(isModelBindingPurpose('background')).toBe(true);
    expect(isModelBindingPurpose('reasoning')).toBe(false);
    expect(isModelBindingPurpose(null)).toBe(false);
  });

  it('guards the catalog capability and definition-kind vocabularies', () => {
    expect(isModelCatalogCapability('text-generation')).toBe(true);
    expect(isModelCatalogCapability('embedding')).toBe(true);
    expect(isModelCatalogCapability('vision')).toBe(false);
    expect(isProviderDefinitionKind('known')).toBe(true);
    expect(isProviderDefinitionKind('custom')).toBe(true);
    expect(isProviderDefinitionKind('builtin')).toBe(false);
  });

  it('maps every W034 known provider to an existing wire protocol (custom providers never invent one)', () => {
    for (const provider of LLM_PROVIDERS) {
      const wireProtocol = knownProviderWireProtocol(provider);
      expect(wireProtocol).not.toBeNull();
      expect(isWireProtocolKind(wireProtocol)).toBe(true);
    }
    // deepseek/groq speak the OpenAI-compatible dialect (W034 adapter set).
    expect(PROVIDER_WIRE_PROTOCOLS['deepseek']).toBe('openai-compatible');
    expect(PROVIDER_WIRE_PROTOCOLS['groq']).toBe('openai-compatible');
    // A slug outside the vocabulary maps to nothing.
    expect(knownProviderWireProtocol('acme-relay')).toBeNull();
  });

  it('validates uuid shape', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});

function PROVIDER_WIRE_PROTOCOLS_OPENAI_FAMILY(): string[] {
  return [...new Set(Object.values(PROVIDER_WIRE_PROTOCOLS))];
}

// ---------------------------------------------------------------------------
// Credential-substring detection (UNANCHORED — lesson 3)
// ---------------------------------------------------------------------------

describe('credential-substring detection', () => {
  it('catches credential-like tokens embedded in URL hosts and userinfo (unanchored)', () => {
    // The exact prior-execution failure shape: a token riding the host.
    expect(containsCredentialLikeToken('https://sk-abc123def456ghi789@api.example.com/v1')).toBe(true);
    expect(containsCredentialLikeToken('https://relay.acme.example.com/v1?api_key=abcdefgh12345')).toBe(true);
    expect(containsCredentialLikeToken('https://api.example.com#sk-abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('catches credential-like tokens in prose notes', () => {
    expect(containsCredentialLikeToken('the key sk-proj-abcdefghijklmnop123456 stopped working')).toBe(true);
    expect(containsCredentialLikeToken('use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 for tests')).toBe(true);
    expect(containsCredentialLikeToken('leaked ghp_abcdefghijklmnopqrstuvwxyz1234567890 yesterday')).toBe(true);
    expect(containsCredentialLikeToken('the AWS key AKIAIOSFODNN7EXAMPLE is compromised')).toBe(true);
    expect(containsCredentialLikeToken('slack token xoxb-1234567890abcdefghij found in logs')).toBe(true);
    expect(containsCredentialLikeToken('password=correcthorsebatterystaple1')).toBe(true);
  });

  it('keeps legitimate prose and URLs clean', () => {
    expect(containsCredentialLikeToken('https://api.openai.com/v1')).toBe(false);
    expect(containsCredentialLikeToken('https://relay.acme.example.com/v1')).toBe(false);
    // Hyphenated numbers must NOT trip the sk- family (left boundary).
    expect(containsCredentialLikeToken('task-20261004120000 completed')).toBe(false);
    expect(containsCredentialLikeToken('context window 128000 tokens')).toBe(false);
    expect(containsCredentialLikeToken('maxOutputTokens: 16384')).toBe(false);
    expect(containsCredentialLikeToken('gpt-4o mini for cognition workloads')).toBe(false);
    expect(containsCredentialLikeToken('the Bearer of the bad news arrived')).toBe(false);
  });
});

describe('note and transport-detail sanitization', () => {
  it('sanitizes user notes: trims, empties to null, rejects credential-shaped content', () => {
    expect(sanitizeUserNote('  provider is up  ')).toBe('provider is up');
    expect(sanitizeUserNote('   ')).toBeNull();
    expect(sanitizeUserNote(null)).toBeNull();
    expectCode('credential_payload_rejected', () =>
      sanitizeUserNote('failing with key sk-abcdefghijklmnop123456'),
    );
    let threw = false;
    try {
      sanitizeUserNote('x'.repeat(501));
    } catch (error) {
      threw = true;
      expect((error as ProviderFabricError).code).toBe('invalid_input');
    }
    expect(threw).toBe(true);
  });

  it('sanitizes transport detail: fallback, truncation, and wholesale withholding', () => {
    expect(sanitizeTransportDetail(null, 'fallback phrase')).toBe('fallback phrase');
    expect(sanitizeTransportDetail('   ', 'fallback phrase')).toBe('fallback phrase');
    expect(sanitizeTransportDetail('connection reset by peer', 'fallback')).toBe('connection reset by peer');
    const long = 'e'.repeat(600);
    expect(sanitizeTransportDetail(long, 'fallback').length).toBe(500);
    // A credential inside transport detail NEVER lands verbatim.
    expect(sanitizeTransportDetail('401 with sk-abcdefghijklmnop123456', 'fallback')).toBe(
      'provider error detail withheld (sanitized)',
    );
  });
});

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

describe('validateConnectKnownProviderInput', () => {
  it('accepts a W034 provider and defaults the label to the slug', () => {
    const valid = validateConnectKnownProviderInput({ provider: 'openai' } as ConnectKnownProviderInput);
    expect(valid).toEqual({ provider: 'openai', label: 'openai' });
    const labeled = validateConnectKnownProviderInput({ provider: 'anthropic', label: 'Claude' });
    expect(labeled).toEqual({ provider: 'anthropic', label: 'Claude' });
  });

  it('rejects providers outside the W034 vocabulary with the typed unsupported_provider', () => {
    expectCode('unsupported_provider', () =>
      validateConnectKnownProviderInput({ provider: 'netflix' } as unknown as ConnectKnownProviderInput),
    );
  });

  it('rejects unknown keys BEFORE any credential scan (lesson 1)', () => {
    // An unknown apiKey KEY fails as an unknown field — never as a
    // credential payload, even though its value is a credential.
    expectCode('invalid_input', () =>
      validateConnectKnownProviderInput({
        provider: 'openai',
        apiKey: 'sk-abcdefghijklmnop123456',
      } as unknown as ConnectKnownProviderInput),
    );
    // And an allowed key with a fine value passes the same shape.
    expect(() => validateConnectKnownProviderInput({ provider: 'openai', label: 'Prod' })).not.toThrow();
  });

  it('rejects credential-shaped labels with the typed credential error', () => {
    expectCode('credential_payload_rejected', () =>
      validateConnectKnownProviderInput({ provider: 'openai', label: 'key sk-abcdefghijklmnop123456' }),
    );
  });
});

describe('validateRegisterCustomProviderInput', () => {
  const GOOD: RegisterCustomProviderInput = {
    provider: 'acme-relay',
    label: 'Acme Relay',
    baseUrl: 'https://relay.acme.example.com/v1',
    wireProtocol: 'openai-compatible',
  };

  it('accepts a custom definition over an existing wire protocol', () => {
    expect(validateRegisterCustomProviderInput(GOOD)).toEqual({
      provider: 'acme-relay',
      label: 'Acme Relay',
      baseUrl: 'https://relay.acme.example.com/v1',
      wireProtocol: 'openai-compatible',
    });
  });

  it('rejects slugs that are not lowercase URL-safe, or that shadow the W034 vocabulary', () => {
    expectCode('invalid_input', () =>
      validateRegisterCustomProviderInput({ ...GOOD, provider: 'Acme-Relay' }),
    );
    expectCode('invalid_input', () => validateRegisterCustomProviderInput({ ...GOOD, provider: 'x' }));
    expectCode('provider_slug_reserved', () =>
      validateRegisterCustomProviderInput({ ...GOOD, provider: 'openai' }),
    );
  });

  it('rejects anything but an existing wire protocol (a custom provider never invents a dialect)', () => {
    expectCode('unsupported_wire_protocol', () =>
      validateRegisterCustomProviderInput({ ...GOOD, wireProtocol: 'grpc' } as unknown as RegisterCustomProviderInput),
    );
    expectCode('unsupported_wire_protocol', () =>
      validateRegisterCustomProviderInput({ ...GOOD, wireProtocol: null } as unknown as RegisterCustomProviderInput),
    );
  });

  it('rejects non-http(s) URLs', () => {
    expectCode('invalid_input', () =>
      validateRegisterCustomProviderInput({ ...GOOD, baseUrl: 'ftp://relay.acme.example.com' }),
    );
    expectCode('invalid_input', () => validateRegisterCustomProviderInput({ ...GOOD, baseUrl: 'not a url' }));
  });

  it('rejects credential-bearing URLs — userinfo and query-embedded tokens (lessons 1+3)', () => {
    expectCode('credential_payload_rejected', () =>
      validateRegisterCustomProviderInput({ ...GOOD, baseUrl: 'https://sk-abcdefgh12345678@api.example.com/v1' }),
    );
    expectCode('credential_payload_rejected', () =>
      validateRegisterCustomProviderInput({ ...GOOD, baseUrl: 'https://api.example.com/v1?key=sk-abcdefgh123456789' }),
    );
  });
});

describe('validateUpdateProviderDefinitionInput', () => {
  const definitionId = '11111111-1111-4111-8111-111111111111';

  it('requires at least one mutable field and validates the status vocabulary', () => {
    expect(validateUpdateProviderDefinitionInput({ definitionId, label: 'New' } as UpdateProviderDefinitionInput)).toEqual({
      definitionId,
      label: 'New',
      status: null,
    });
    expect(validateUpdateProviderDefinitionInput({ definitionId, status: 'disabled' })).toEqual({
      definitionId,
      label: null,
      status: 'disabled',
    });
    expectCode('invalid_input', () => validateUpdateProviderDefinitionInput({ definitionId }));
    expectCode('invalid_input', () =>
      validateUpdateProviderDefinitionInput({ definitionId, status: 'paused' } as unknown as UpdateProviderDefinitionInput),
    );
    // Identity fields are not updatable — unknown keys.
    expectCode('invalid_input', () =>
      validateUpdateProviderDefinitionInput({ definitionId, provider: 'anthropic' } as unknown as UpdateProviderDefinitionInput),
    );
  });
});

describe('list query validation', () => {
  it('validates definition list filters and the limit bounds', () => {
    const valid = validateListProviderDefinitionsQuery({ kind: 'custom', status: 'active', limit: 10 });
    expect(valid).toEqual({ kind: 'custom', status: 'active', provider: null, limit: 10 });
    expect(validateListProviderDefinitionsQuery({}).limit).toBe(50);
    expectCode('invalid_query', () => validateListProviderDefinitionsQuery({ kind: 'builtin' } as never));
    expectCode('invalid_query', () => validateListProviderDefinitionsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListProviderDefinitionsQuery({ limit: 501 }));
  });

  it('validates catalog list filters (uuid shape for the definition filter)', () => {
    expectCode('invalid_query', () =>
      validateListModelCatalogQuery({ definitionId: 'not-a-uuid' } as never),
    );
    expectCode('invalid_query', () => validateListModelCatalogQuery({ origin: 'guessed' } as never));
    expectCode('invalid_query', () => validateListModelCatalogQuery({ capability: 'vision' } as never));
    expect(validateListModelCatalogQuery({ definitionId: '11111111-1111-4111-8111-111111111111' })).toMatchObject({
      definitionId: '11111111-1111-4111-8111-111111111111',
      limit: 50,
    });
  });

  it('validates binding list filters', () => {
    expectCode('invalid_query', () => validateListModelBindingsQuery({ purpose: 'reasoning' } as never));
    expectCode('invalid_query', () => validateListModelBindingsQuery({ status: 'detached' } as never));
    expect(validateListModelBindingsQuery({ purpose: 'cognition', status: 'active' })).toEqual({
      purpose: 'cognition',
      status: 'active',
      limit: 50,
    });
  });
});

// ---------------------------------------------------------------------------
// Model samples and manual registration (lessons 1+2)
// ---------------------------------------------------------------------------

describe('validateModelSample — the sample gate (lesson 2)', () => {
  it('accepts exactly the sample keys and normalizes', () => {
    const valid = validateModelSample(
      {
        modelId: 'gpt-4o-mini',
        displayName: '  GPT-4o mini  ',
        capabilities: ['text-generation', 'text-generation'],
        contextWindowTokens: 128000,
        maxOutputTokens: 16384,
        priceInputMinorPerMillion: 15,
        priceOutputMinorPerMillion: 60,
      },
      false,
    );
    expect(valid.displayName).toBe('GPT-4o mini');
    expect(valid.capabilities).toEqual(['text-generation']); // deduped
    expect(valid.contextWindowTokens).toBe(128000);
  });

  it('REJECTS reference and system-minted keys — the wrapper must strip them first', () => {
    for (const smuggled of ['definitionId', 'entryId', 'origin', 'discoveredAt', 'status', 'tenantId']) {
      expectCode('invalid_input', () =>
        validateModelSample({ modelId: 'm', displayName: 'M', [smuggled]: 'x' }, false),
      );
    }
  });

  it('treats null capabilities/unknown metadata as honest unknowns', () => {
    const valid = validateModelSample({ modelId: 'mystery-model' }, false);
    expect(valid.displayName).toBeNull();
    expect(valid.capabilities).toEqual([]);
    expect(valid.contextWindowTokens).toBeNull();
    expect(valid.priceInputMinorPerMillion).toBeNull();
  });

  it('rejects bad vocabulary and bounds with (from transport) provider_malformed_response', () => {
    expectCode('invalid_input', () =>
      validateModelSample({ modelId: 'm', capabilities: ['vision'] }, false),
    );
    expectCode('invalid_input', () => validateModelSample({ modelId: 'm', contextWindowTokens: 0 }, false));
    expectCode('invalid_input', () => validateModelSample({ modelId: 'm', maxOutputTokens: -1 }, false));
    expectCode('provider_malformed_response', () =>
      validateModelSample({ modelId: 'm', capabilities: ['vision'] }, true),
    );
    expectCode('credential_payload_rejected', () =>
      validateModelSample({ modelId: 'sk-abcdefghijklmnop123456' }, false),
    );
  });
});

describe('validateRegisterModelInput — the manual path', () => {
  const definitionId = '33333333-3333-4333-8333-333333333333';

  it('accepts definitionId + sample keys together (allowed keys first — lesson 1)', () => {
    const valid = validateRegisterModelInput({
      definitionId,
      modelId: 'acme-large-24b',
      displayName: 'Acme Large 24B',
      capabilities: ['text-generation'],
      contextWindowTokens: 200000,
      maxOutputTokens: 8192,
      priceInputMinorPerMillion: 100,
      priceOutputMinorPerMillion: 400,
    } as RegisterModelManuallyInput);
    expect(valid.definitionId).toBe(definitionId);
    expect(valid.sample.modelId).toBe('acme-large-24b');
    expect(valid.sample.displayName).toBe('Acme Large 24B');
    expect(valid.sample.capabilities).toEqual(['text-generation']);
  });

  it('requires a display name for manual registration', () => {
    expectCode('invalid_input', () =>
      validateRegisterModelInput({ definitionId, modelId: 'm' } as RegisterModelManuallyInput),
    );
  });

  it('rejects unknown keys (apiKey fails as an unknown field, never a credential scan)', () => {
    expectCode('invalid_input', () =>
      validateRegisterModelInput({
        definitionId,
        modelId: 'm',
        displayName: 'M',
        apiKey: 'sk-abcdefghijklmnop123456',
      } as unknown as RegisterModelManuallyInput),
    );
  });
});

// ---------------------------------------------------------------------------
// Discovery receipts
// ---------------------------------------------------------------------------

describe('validateDiscoveryReceipt', () => {
  it('normalizes a succeeded receipt with validated samples', () => {
    const receipt = validateDiscoveryReceipt({
      status: 'succeeded',
      models: [
        { modelId: 'gpt-4o', displayName: null, capabilities: null, contextWindowTokens: null, maxOutputTokens: null, priceInputMinorPerMillion: null, priceOutputMinorPerMillion: null },
        { modelId: 'gpt-4o-mini', displayName: 'mini', capabilities: ['text-generation'], contextWindowTokens: 1, maxOutputTokens: 2, priceInputMinorPerMillion: 3, priceOutputMinorPerMillion: 4 },
      ],
      detail: null,
    });
    expect(receipt.status).toBe('succeeded');
    expect(receipt.models).toHaveLength(2);
    expect(receipt.models[0]!.displayName).toBeNull();
    expect(receipt.models[1]!.contextWindowTokens).toBe(1);
  });

  it('drops models on non-succeeded receipts and validates the status vocabulary', () => {
    expect(validateDiscoveryReceipt({ status: 'unsupported', models: [{ modelId: 'x' }], detail: 'no route' })).toEqual({
      status: 'unsupported',
      models: [],
      detail: 'no route',
    });
    expectCode('provider_malformed_response', () => validateDiscoveryReceipt({ status: 'timeout' }));
    expectCode('provider_malformed_response', () => validateDiscoveryReceipt('nope' as never));
  });

  it('fails loudly on malformed samples and duplicate model ids', () => {
    expectCode('provider_malformed_response', () =>
      validateDiscoveryReceipt({ status: 'succeeded', models: [{ modelId: '' }] }),
    );
    expectCode('provider_malformed_response', () =>
      validateDiscoveryReceipt({
        status: 'succeeded',
        models: [
          { modelId: 'same' },
          { modelId: 'same' },
        ],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Bindings and health inputs
// ---------------------------------------------------------------------------

describe('validateAttachModelBindingInput', () => {
  const GOOD = {
    purpose: 'cognition',
    definitionId: '33333333-3333-4333-8333-333333333333',
    modelId: 'gpt-4o',
    accountId: '44444444-4444-4444-8444-444444444444',
  };

  it('accepts a well-formed attach input', () => {
    expect(validateAttachModelBindingInput(GOOD)).toEqual(GOOD);
  });

  it('validates the purpose vocabulary, the uuid account shape and the model id', () => {
    expectCode('invalid_input', () => validateAttachModelBindingInput({ ...GOOD, purpose: 'reasoning' } as never));
    expectCode('invalid_input', () => validateAttachModelBindingInput({ ...GOOD, accountId: 'not-a-uuid' }));
    expectCode('invalid_input', () => validateAttachModelBindingInput({ ...GOOD, modelId: '   ' }));
    expectCode('credential_payload_rejected', () =>
      validateAttachModelBindingInput({ ...GOOD, modelId: 'sk-abcdefghijklmnop123456' }),
    );
    // Unknown keys first (lesson 1): a credentialRef key is an unknown key.
    expectCode('invalid_input', () =>
      validateAttachModelBindingInput({ ...GOOD, credentialRef: 'secret-store://x' } as never),
    );
  });
});

describe('validateRecordProviderHealthInput', () => {
  const definitionId = '33333333-3333-4333-8333-333333333333';

  it('accepts manual and execution observations with sanitized notes', () => {
    expect(
      validateRecordProviderHealthInput({ definitionId, state: 'available', basis: 'manual', note: ' back up ' }),
    ).toEqual({ definitionId, state: 'available', basis: 'manual', note: 'back up' });
    expect(
      validateRecordProviderHealthInput({ definitionId, state: 'unavailable', basis: 'execution' }),
    ).toEqual({ definitionId, state: 'unavailable', basis: 'execution', note: null });
  });

  it('reserves unknown/verification/none for the fabric itself', () => {
    expectCode('invalid_input', () =>
      validateRecordProviderHealthInput({ definitionId, state: 'unknown', basis: 'manual' } as never),
    );
    expectCode('invalid_input', () =>
      validateRecordProviderHealthInput({ definitionId, state: 'available', basis: 'verification' } as never),
    );
    expectCode('invalid_input', () =>
      validateRecordProviderHealthInput({ definitionId, state: 'available', basis: 'none' } as never),
    );
  });

  it('rejects credential-shaped notes with the typed error', () => {
    expectCode('credential_payload_rejected', () =>
      validateRecordProviderHealthInput({
        definitionId,
        state: 'unavailable',
        basis: 'manual',
        note: 'auth fails with sk-abcdefghijklmnop123456',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The sample key set itself (lesson 2, structural)
// ---------------------------------------------------------------------------

describe('MODEL_SAMPLE_KEYS', () => {
  it('contains exactly the sample keys — no reference or system keys', () => {
    expect([...MODEL_SAMPLE_KEYS].sort()).toEqual([
      'capabilities',
      'contextWindowTokens',
      'displayName',
      'maxOutputTokens',
      'modelId',
      'priceInputMinorPerMillion',
      'priceOutputMinorPerMillion',
    ]);
  });
});

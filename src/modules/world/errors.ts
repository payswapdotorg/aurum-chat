// Typed errors of the world module. Consumers catch `WorldError` and branch
// on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`entity_not_found` / `relationship_not_found`) — the existence of
// another tenant's world must never leak (ADR-0001). This includes
// relationship endpoints: an entity of another tenant used as `from`/`to`
// is reported as `entity_not_found`, never as "belongs to another tenant".

export type WorldErrorCode =
  | 'invalid_context'
  | 'invalid_entity_input'
  | 'invalid_relationship_input'
  | 'invalid_world_query'
  | 'invalid_registration_input'
  | 'entity_not_found'
  | 'relationship_not_found'
  | 'unknown_entity_kind'
  | 'entity_kind_reserved'
  | 'entity_kind_conflict'
  | 'unknown_relationship_type'
  | 'relationship_type_reserved'
  | 'duplicate_relationship'
  | 'external_ref_in_use';

export class WorldError extends Error {
  constructor(
    public readonly code: WorldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorldError';
  }
}

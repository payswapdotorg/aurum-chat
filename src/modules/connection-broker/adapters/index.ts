// The broker adapter registry (MODULE-INTERNAL). The canonical port types
// live in ../types (public — wiring code constructs adapters through the
// factories re-exported by the module contract); the two first-party
// adapters live here:
//
//   * nango    — the managed connection broker candidate (W082: "Nango as
//                the first candidate");
//   * embedded — the shipped equivalent alternative (self-managed OAuth
//                broker) proving broker replaceability.
//
// Third-party equivalents implement the same `ConnectionBroker` port and
// are wired through `wireConnectionBrokers` without any domain change.

export { createNangoBroker, NANGO_BROKER_KEY, type NangoBrokerConfig } from './nango';
export { createEmbeddedBroker, EMBEDDED_BROKER_KEY, type EmbeddedBrokerConfig } from './embedded';
export { BrokerAdapterError, BROKER_CAPABILITIES, BROKER_GATEWAY } from './shared';

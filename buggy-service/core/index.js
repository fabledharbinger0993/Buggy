// Core entry point for Buggy's research engine
const Evidence = require('./evidence');
const { Gap, identifyGaps } = require('./gapIdentifier');
const { inferConnections } = require('./connectionEngine');
const { traceEvidence } = require('./traceability');

module.exports = {
  Evidence,
  Gap,
  identifyGaps,
  inferConnections,
  traceEvidence
};

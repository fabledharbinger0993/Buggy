// TRACEABILITY MODULE
// Ensures all outputs can be traced back to their sources or gaps.

export function traceEvidence(evidence) {
  // Return a trace object showing source, confidence, and connection path
  return {
    id: evidence.id,
    source: evidence.source,
    confidence: evidence.confidence,
    connections: evidence.connections
  };
}



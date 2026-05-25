// EVIDENCE MODULE
// Handles evidence objects, their structure, and traceability.

class Evidence {
  constructor({ id, description, source, confidence, connections = [] }) {
    this.id = id;
    this.description = description;
    this.source = source; // URL, citation, or null if missing
    this.confidence = confidence; // 0-1 scale
    this.connections = connections; // Array of Evidence IDs
  }
}

module.exports = Evidence;

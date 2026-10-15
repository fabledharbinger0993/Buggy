export class Evidence {
  constructor({ id, description, source, confidence, connections = [] }) {
    this.id = id;
    this.description = description;
    this.source = source;
    this.confidence = confidence;
    this.connections = connections;
  }
}

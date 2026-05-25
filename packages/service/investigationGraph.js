// investigationGraph.js
// Live investigation graph built during an expansion run.
// Nodes deduplicate by normalized name. Edges deduplicate by from→to key.

export class InvestigationGraph {
  constructor() {
    this.nodes = new Map(); // normalized key → node
    this.edges  = new Map(); // "from→to" key → edge
  }

  _key(value) {
    return String(value).trim().toLowerCase();
  }

  addNode({ id, type, depth, context, relevance, connections = [] }) {
    const key = this._key(id);
    if (this.nodes.has(key)) {
      const n = this.nodes.get(key);
      if (relevance > n.relevance) {
        n.context    = context;
        n.relevance  = relevance;
      }
      n.connections = [...new Set([...n.connections, ...connections])];
      n.depth       = Math.min(n.depth, depth); // keep shallowest path
    } else {
      this.nodes.set(key, { id: id.trim(), type, depth, context, relevance, connections });
    }
  }

  addEdge(from, to, strength, rationale) {
    const key = `${this._key(from)}→${this._key(to)}`;
    if (!this.edges.has(key)) {
      this.edges.set(key, { from: from.trim(), to: to.trim(), strength, rationale });
    }
  }

  toJSON() {
    return {
      nodes:      [...this.nodes.values()],
      edges:      [...this.edges.values()],
      nodeCount:  this.nodes.size,
      edgeCount:  this.edges.size,
    };
  }
}

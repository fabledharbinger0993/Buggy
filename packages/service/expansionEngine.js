// expansionEngine.js
// Recursive, agentic research/expansion engine for Buggy
// Maintains a dynamic queue of leads (entities, findings, connections)
// Recursively spawns sub-searches for each lead, aggregates and merges results

import { randomUUID } from "crypto";

/**
 * Lead types: entity, connection, claim, url, etc.
 * Each lead is an object: { type, value, depth, parentId, ... }
 */
export class ExpansionEngine {
  constructor({ maxDepth = 3, maxBreadth = 100 } = {}) {
    this.maxDepth = maxDepth;
    this.maxBreadth = maxBreadth;
    this.queue = [];
    this.visited = new Set();
    this.results = [];
  }

  /**
   * Add a new lead to the queue if not already visited
   */
  enqueue(lead) {
    const key = this._leadKey(lead);
    if (!this.visited.has(key) && this.queue.length < this.maxBreadth) {
      this.queue.push(lead);
      this.visited.add(key);
    }
  }

  /**
   * Main expansion loop: recursively process leads
   * @param {function} processLead - async function(lead, engine) => { newLeads, result }
   */
  async expand(processLead) {
    while (this.queue.length > 0) {
      const lead = this.queue.shift();
      if (lead.depth > this.maxDepth) continue;
      try {
        const { newLeads = [], result = null } = await processLead(lead, this);
        for (const newLead of newLeads) {
          this.enqueue({ ...newLead, depth: (lead.depth || 0) + 1, parentId: lead.id || null });
        }
        if (result) this.results.push(result);
      } catch (err) {
        // Optionally log or collect errors
      }
    }
    return this.results;
  }

  /**
   * Helper to generate a unique key for a lead
   */
  _leadKey(lead) {
    return `${lead.type}:${lead.value}`;
  }
}

// Example usage (to be integrated in pipeline):
// const engine = new ExpansionEngine({ maxDepth: 3 });
// engine.enqueue({ type: 'entity', value: 'Some Entity', depth: 0 });
// const results = await engine.expand(async (lead, engine) => { ... });

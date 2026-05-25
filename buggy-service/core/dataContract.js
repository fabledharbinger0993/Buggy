// DATA CONTRACT: Defines the structure for frontend-backend communication

/**
 * EvidenceItem: {
 *   id: string,
 *   description: string,
 *   source: string | null,
 *   confidence: number, // 0-1
 *   connections: Array<string>, // Evidence IDs
 * }
 *
 * GapItem: {
 *   id: string,
 *   description: string,
 *   context: string,
 *   severity: 'critical' | 'moderate' | 'minor',
 * }
 *
 * Connection: {
 *   from: string, // Evidence ID
 *   to: string,   // Evidence ID
 *   strength: number, // 0-1
 *   rationale: string
 * }
 */

module.exports = {};

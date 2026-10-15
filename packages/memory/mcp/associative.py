import os
import pickle
from typing import Any, Optional
import networkx as nx
from .config import GRAPH_PATH

_graph: nx.DiGraph | None = None

VALID_EDGE_TYPES = {
    "SUPPORTS", "CONTRADICTS", "ELABORATES", "TRIGGERS",
    "AUTHORED", "INSPIRED_BY", "QUESTIONS", "RESPONDS_TO",
    "REFINES", "EXPRESSES",
}

def _load_graph() -> nx.DiGraph:
    global _graph
    if _graph is None:
        if os.path.exists(GRAPH_PATH):
            with open(GRAPH_PATH, "rb") as f:
                _graph = pickle.load(f)
        else:
            _graph = nx.DiGraph()
    return _graph

def _save_graph() -> None:
    g = _load_graph()
    with open(GRAPH_PATH, "wb") as f:
        pickle.dump(g, f, protocol=pickle.HIGHEST_PROTOCOL)

def add_node(concept: str, node_type: str = "concept", **attrs: Any) -> None:
    g = _load_graph()
    if not g.has_node(concept):
        g.add_node(concept, node_type=node_type, **attrs)
        _save_graph()

def add_edge(
    source: str,
    target: str,
    relationship: str,
    weight: float = 1.0,
) -> None:
    if relationship not in VALID_EDGE_TYPES:
        raise ValueError(f"Invalid relationship type: {relationship}. Must be one of {VALID_EDGE_TYPES}")
    g = _load_graph()
    add_node(source)
    add_node(target)
    g.add_edge(source, target, relationship=relationship, weight=weight)
    _save_graph()

def get_neighbors(
    concept: str,
    depth: int = 2,
    relationship_types: Optional[list[str]] = None,
) -> dict[str, Any]:
    depth = min(depth, 4)
    g = _load_graph()
    if not g.has_node(concept):
        return {"concept": concept, "found": False, "nodes": [], "edges": []}
    visited_nodes: dict[str, Any] = {}
    visited_edges: list[dict[str, Any]] = []
    def traverse(node: str, current_depth: int) -> None:
        if current_depth > depth or node in visited_nodes:
            return
        node_data = dict(g.nodes.get(node, {}))
        visited_nodes[node] = {"id": node, "depth": current_depth, **node_data}
        for _, neighbor, edge_data in g.out_edges(node, data=True):
            rel = edge_data.get("relationship", "UNKNOWN")
            if relationship_types and rel not in relationship_types:
                continue
            edge_key = f"{node}->{neighbor}:{rel}"
            visited_edges.append({
                "source": node,
                "target": neighbor,
                "relationship": rel,
                "weight": edge_data.get("weight", 1.0),
            })
            traverse(neighbor, current_depth + 1)
        for predecessor, _, edge_data in g.in_edges(node, data=True):
            rel = edge_data.get("relationship", "UNKNOWN")
            if relationship_types and rel not in relationship_types:
                continue
            visited_edges.append({
                "source": predecessor,
                "target": node,
                "relationship": rel,
                "weight": edge_data.get("weight", 1.0),
            })
            traverse(predecessor, current_depth + 1)
    traverse(concept, 0)
    return {
        "concept": concept,
        "found": True,
        "depth_searched": depth,
        "nodes": list(visited_nodes.values()),
        "edges": visited_edges,
        "total_nodes": len(visited_nodes),
        "total_edges": len(visited_edges),
    }
def graph_node_count() -> int:
    return _load_graph().number_of_nodes()
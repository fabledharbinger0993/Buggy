import uuid
from fastapi import FastAPI
from pydantic import BaseModel
from .mcp.holographic import add_to_holographic, query_holographic
from .mcp.associative import get_neighbors

app = FastAPI(title="FungAI Memory (MCP)")

class StoreReq(BaseModel):
    content: str
    confidence: float = 0.7
    source: str = ""
    tags: list[str] = []


class QueryReq(BaseModel):
    query: str
    top_k: int = 5
    holographic: bool = False
    min_confidence: float = 0.0


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/memory/store")
async def store_memory(body: StoreReq):
    if not body.content.strip():
        return {"accepted": False, "error": "empty content"}
    mem_id = str(uuid.uuid4())
    ok = add_to_holographic(mem_id, body.content)
    return {"accepted": ok, "id": mem_id}


@app.post("/memory/query")
async def query_memory(body: QueryReq):
    if body.top_k <= 0:
        return {"results": []}
    results = query_holographic(body.query, top_k=body.top_k)
    if body.min_confidence > 0:
        results = [r for r in results if r.get("confidence", 1.0) >= body.min_confidence]
    return {"results": results}


@app.get("/memory/neighbors")
async def graph_neighbors_endpoint(concept: str, depth: int = 2):
    result = get_neighbors(concept, depth=depth)
    return result

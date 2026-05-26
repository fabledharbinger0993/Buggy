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
    # No direct count, so just return ok
    return {"ok": True}


@app.post("/memory/store")
async def store_memory(body: StoreReq):
    mem_id = str(uuid.uuid4())
    ok = add_to_holographic(mem_id, body.content)
    # Optionally, you could also add to associative graph here for concept/tag linkage
    return {"accepted": ok, "id": mem_id}


@app.post("/memory/query")
async def query_memory(body: QueryReq):
    # Only holographic query for now
    results = query_holographic(body.query, top_k=body.top_k)
    return {"results": results}


@app.get("/memory/neighbors")
async def graph_neighbors_endpoint(concept: str, depth: int = 2):
    # Use associative graph for neighbor queries
    result = get_neighbors(concept, depth=depth)
    return result

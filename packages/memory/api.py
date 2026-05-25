import os
import uuid
from pathlib import Path
from contextlib import asynccontextmanager

import chromadb
from chromadb.utils import embedding_functions
from fastapi import FastAPI
from pydantic import BaseModel

CHROMA_PATH = os.getenv("CHROMA_PATH", "./data/chromadb")
COLLECTION  = "fungai_memory"

_client     = None
_collection = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _client, _collection
    Path(CHROMA_PATH).mkdir(parents=True, exist_ok=True)
    _client = chromadb.PersistentClient(path=CHROMA_PATH)
    ef = embedding_functions.DefaultEmbeddingFunction()
    _collection = _client.get_or_create_collection(COLLECTION, embedding_function=ef)
    print(f"[memory] ChromaDB ready — {_collection.count()} existing memories")
    yield


app = FastAPI(title="FungAI Memory", lifespan=lifespan)


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
    return {"ok": True, "memories": _collection.count() if _collection else 0}


@app.post("/memory/store")
async def store_memory(body: StoreReq):
    mem_id = str(uuid.uuid4())
    _collection.add(
        documents=[body.content],
        ids=[mem_id],
        metadatas=[{
            "confidence": body.confidence,
            "source":     body.source,
            "tags":       ",".join(body.tags),
        }],
    )
    return {"accepted": True, "id": mem_id}


@app.post("/memory/query")
async def query_memory(body: QueryReq):
    count = _collection.count()
    if count == 0:
        return {"results": []}
    results = _collection.query(
        query_texts=[body.query],
        n_results=min(max(1, body.top_k), count),
        include=["documents", "metadatas", "distances"],
    )
    docs      = results["documents"][0] if results["documents"] else []
    metas     = results["metadatas"][0]  if results["metadatas"]  else []
    distances = results["distances"][0]  if results["distances"]  else []
    out = []
    for doc, meta, dist in zip(docs, metas, distances):
        conf = float(meta.get("confidence", 0.0))
        if conf < body.min_confidence:
            continue
        out.append({
            "content":    doc,
            "confidence": conf,
            "source":     meta.get("source", ""),
            "tags":       [t for t in meta.get("tags", "").split(",") if t],
            "distance":   round(float(dist), 4),
        })
    return {"results": out}


@app.get("/memory/neighbors")
async def graph_neighbors(concept: str, depth: int = 2):
    count = _collection.count()
    if count == 0:
        return {"concept": concept, "neighbors": []}
    # Semantic search for memories near this concept, then surface their tags as neighbors
    results = _collection.query(
        query_texts=[concept],
        n_results=min(10, count),
        include=["metadatas", "distances"],
    )
    metas     = results["metadatas"][0] if results["metadatas"] else []
    distances = results["distances"][0]  if results["distances"]  else []
    neighbor_scores: dict[str, float] = {}
    for meta, dist in zip(metas, distances):
        similarity = max(0.0, 1.0 - float(dist))
        tags = [t for t in meta.get("tags", "").split(",") if t]
        for tag in tags:
            if tag.lower() == concept.lower():
                continue
            neighbor_scores[tag] = max(neighbor_scores.get(tag, 0.0), similarity)
    neighbors = [
        {"concept": tag, "strength": round(score, 3)}
        for tag, score in sorted(neighbor_scores.items(), key=lambda x: -x[1])
    ]
    return {"concept": concept, "neighbors": neighbors[:20]}

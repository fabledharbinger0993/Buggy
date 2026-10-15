import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "holograim.db")
GRAPH_PATH = os.path.join(DATA_DIR, "graph.gpickle")
COMPOSITE_PATH = os.path.join(DATA_DIR, "holographic_composite.npy")
CHROMA_PATH = os.path.join(DATA_DIR, "chroma")
OLLAMA_HOST = "http://localhost:11434"
OLLAMA_MODEL = "qwen2.5:3b"
OLLAMA_FALLBACK = "llama3.2:1b"
MEMORY_PERSISTENCE_THRESHOLD = 0.7
BELIEF_FORMATION_THRESHOLD = 0.3
BELIEF_FORMATION_MIN_MEMORIES = 3
BELIEF_DECAY_RATE = 0.02
BELIEF_ARCHIVE_THRESHOLD = 0.1
TENSION_OSCILLATION_MIN = 3
TENSION_AMPLITUDE_FLAG = 2.0
HDC_DIMENSION = 10000
RENDERS_DIR = os.path.join(DATA_DIR, "renders")
EXECUTION_TIMEOUT_DEFAULT = 15  # seconds
SHELL_WHITELIST = {
    "ls", "cat", "head", "tail", "grep", "find", "echo", "pwd", "wc",
    "du", "df", "date", "uname", "which", "env", "printenv", "sort",
    "uniq", "cut", "awk", "sed", "tr", "tee", "diff", "md5sum",
    "sha256sum", "file", "stat", "basename", "dirname",
}
os.makedirs(RENDERS_DIR, exist_ok=True)
